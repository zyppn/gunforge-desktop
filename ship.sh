#!/usr/bin/env bash
# ship.sh — one command: test, release the client, deploy the server, verify both.
#
#   ./ship.sh              patch bump   (1.4.46 -> 1.4.47)
#   ./ship.sh minor        1.4.46 -> 1.5.0
#   ./ship.sh 1.5.0        exact version
#   ./ship.sh --server     deploy the server only, no version bump
#   ./ship.sh --client     release the client only, no server deploy
#   ./ship.sh --no-wait    do not wait for the installer build
#
# Connection settings live in .deploy.conf (gitignored). First run asks for them.
set -euo pipefail
cd "$(dirname "$0")"
say(){ printf '\n\033[1;33m==> %s\033[0m\n' "$*"; }
die(){ printf '\n\033[1;31mx  %s\033[0m\n' "$*" >&2; exit 1; }

DO_CLIENT=1; DO_SERVER=1; DO_WAIT=1; BUMP="patch"
for a in "$@"; do case "$a" in
  --server) DO_CLIENT=0 ;;
  --client) DO_SERVER=0 ;;
  --no-wait) DO_WAIT=0 ;;
  -*) die "unknown flag $a" ;;
  *)  BUMP="$a" ;;
esac; done

# ---------------------------------------------------------------- config
CONF=".deploy.conf"
if [ ! -f "$CONF" ] && [ "$DO_SERVER" -eq 1 ]; then
  say "First run — how do I reach the arena server?"
  cat <<'WHY'
  Asked once, then saved. These are the values you already use by hand:

    ssh target   what you type after "ssh". Oracle images default to
                 ubuntu@<ip> on Ubuntu, opc@<ip> on Oracle Linux.
                 Not sure? ^C and run:  history | grep -i ssh
    repo path    where you cd to on the box before "git pull"
    service      the pm2 name or systemd unit that runs the arena

  Just want the app out right now? ^C and run:  ./ship.sh --client
WHY
  read -r -p "  ssh target : " H
  [ -n "$H" ] || die "no ssh target — ./ship.sh --client releases the client alone"
  read -r -p "  identity file, blank if your ssh config handles it : " K
  read -r -p "  repo path on that box [~/gunforge-desktop] : " P; P="${P:-~/gunforge-desktop}"
  read -r -p "  systemd unit [gunforge] : " S; S="${S:-gunforge}"
  # NOT %q: it escapes a leading ~ to \~, which then expands to nothing on either end
  { echo "DEPLOY_HOST=\"$H\""; echo "DEPLOY_KEY=\"$K\""; echo "DEPLOY_PATH=\"$P\"";
    echo "DEPLOY_SVC=\"$S\""; echo "DEPLOY_PORT=2567"; } > "$CONF"
  echo "  saved to $CONF (gitignored) — you won't be asked again"
fi
# shellcheck disable=SC1090
[ -f "$CONF" ] && . "$CONF"
# the unit is named gunforge.service; accept either spelling and normalise
DEPLOY_SVC="${DEPLOY_SVC:-gunforge}"; DEPLOY_SVC="${DEPLOY_SVC%.service}"
# No -t: the remote script arrives on stdin as a heredoc, so ssh cannot allocate a
# tty anyway and only prints a warning about it. That means sudo has to be passwordless
# for this user - which it is, or the restart in the run that proved this out would
# have hung. If that ever changes, this needs a different shape, not a -t.
SSH=(ssh)
[ -n "${DEPLOY_KEY:-}" ] && SSH+=(-i "${DEPLOY_KEY/#\~/$HOME}")

# ---------------------------------------------------------------- preflight
say "Preflight"
[ -z "$(git status --porcelain)" ] || die "working tree is dirty — commit or stash first"
BRANCH="$(git rev-parse --abbrev-ref HEAD)"
npm run sync:core >/dev/null
cmp -s server/loadout-core.js renderer/vendor/loadout-core.js \
  || die "loadout-core.js differs between server/ and renderer/vendor/ after sync"
echo "  loadout-core byte-identical"

say "Tests"
FAILED=0
for t in server/test/*.test.js renderer/test/*.test.js; do
  case "$t" in *controls*) continue ;; esac          # needs playwright, not part of the gate
  printf '  %-44s' "$t"
  if node "$t" >/tmp/ship-test.log 2>&1; then echo "ok"; else echo "FAIL"; tail -20 /tmp/ship-test.log; FAILED=1; fi
done
[ "$FAILED" -eq 0 ] || die "tests failed — nothing shipped"

# ---------------------------------------------------------------- client
if [ "$DO_CLIENT" -eq 1 ]; then
  CUR="$(node -p "require('./package.json').version")"
  if [[ "$BUMP" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then NEXT="$BUMP"; else
    IFS='.' read -r MA MI PA <<< "$CUR"
    case "$BUMP" in
      major) NEXT="$((MA+1)).0.0" ;;
      minor) NEXT="$MA.$((MI+1)).0" ;;
      patch) NEXT="$MA.$MI.$((PA+1))" ;;
      *) die "usage: ./ship.sh [patch|minor|major|x.y.z]" ;;
    esac
  fi
  say "Client  $CUR -> $NEXT"
  node -e "const f='package.json',p=JSON.parse(require('fs').readFileSync(f,'utf8'));p.version='$NEXT';require('fs').writeFileSync(f,JSON.stringify(p,null,2)+'\n')"
  git add package.json && git commit -qm "release v$NEXT" && git tag "v$NEXT"
fi

say "Push"
git push -q origin "$BRANCH"
git push -q --tags
LOCAL="$(git rev-parse --short HEAD)"
echo "  $BRANCH at $LOCAL"

# ---------------------------------------------------------------- server
if [ "$DO_SERVER" -eq 1 ]; then
  say "Server  $DEPLOY_HOST"
  # Everything the box does, in one round trip, ending in the proof it worked.
  # /health reports uptime in seconds, so a small "up" is evidence the process
  # actually RESTARTED - reachable is not the same as restarted, and a deploy that
  # pulled but left the old process running is the failure this exists to catch.
  OUT="$("${SSH[@]}" "$DEPLOY_HOST" "bash -se" <<REMOTE
set -euo pipefail
cd ${DEPLOY_PATH}
git fetch --quiet origin
git reset --hard --quiet origin/$BRANCH
if ! git diff --quiet 'HEAD@{1}' HEAD -- package-lock.json 2>/dev/null; then
  npm ci --omit=dev --silent && echo "  lockfile moved — dependencies reinstalled"
fi
sudo systemctl restart $DEPLOY_SVC.service
for i in \$(seq 1 15); do
  H=\$(curl -sf --max-time 2 localhost:$DEPLOY_PORT/health || true)
  [ -n "\$H" ] && break
  sleep 1
done
echo "SHA=\$(git rev-parse --short HEAD)"
echo "HEALTH=\$H"
REMOTE
)"
  echo "$OUT" | grep '^  ' || true
  REMOTE_SHA="$(printf '%s' "$OUT" | sed -n 's/^SHA=//p' | tr -d '\r')"
  HEALTH="$(printf '%s' "$OUT" | sed -n 's/^HEALTH=//p' | tr -d '\r')"

  say "Verify"
  [ -n "$HEALTH" ] || die "no /health response — the arena did not come back up"
  [ "$REMOTE_SHA" = "$LOCAL" ] || die "box is on $REMOTE_SHA, expected $LOCAL — the pull did not take"
  UP="$(printf '%s' "$HEALTH" | sed -n 's/.*"up":"\([0-9]*\)s".*/\1/p')"
  [ -n "$UP" ] && [ "$UP" -lt 60 ] \
    || die "arena reports up=${UP:-?}s — it answered, but it never restarted"
  echo "  box on $REMOTE_SHA, arena up ${UP}s"
fi

# ---------------------------------------------------------------- installers
# There is nothing to "publish": the workflow creates the release with
# draft:false before any build runs, so v$NEXT is live the moment it is tagged.
# What is worth waiting for is whether the three installers actually landed on
# it - a release that exists with no assets, or missing latest*.yml, is a broken
# auto-update for everyone who already has the app.
if [ "$DO_CLIENT" -eq 1 ] && [ "$DO_WAIT" -eq 1 ]; then
  if command -v gh >/dev/null 2>&1 && gh auth status >/dev/null 2>&1; then
    say "Installers  v$NEXT"
    echo "  waiting for the build (ctrl-C is safe, it keeps running on GitHub)"
    sleep 8
    RUN="$(gh run list --workflow="Build and release" --limit 1 --json databaseId --jq '.[0].databaseId' 2>/dev/null || true)"
    if [ -n "$RUN" ]; then gh run watch "$RUN" --exit-status >/dev/null 2>&1 || true; fi
    ASSETS="$(gh release view "v$NEXT" --json assets --jq '.assets | length' 2>/dev/null || echo 0)"
    if [ "${ASSETS:-0}" -gt 0 ]; then
      echo "  v$NEXT is live with $ASSETS assets:"
      gh release view "v$NEXT" --json assets --jq '.assets[].name' | sed 's/^/    /'
      gh release view "v$NEXT" --json assets --jq '.assets[].name' | grep -q 'latest.*yml' \
        || echo "  !! no latest*.yml — auto-update will not see this release"
    else
      echo "  !! v$NEXT has no assets yet — check https://github.com/zyppn/gunforge-desktop/actions"
    fi
  else
    echo "  (install the gh CLI and I can watch the build for you: brew install gh && gh auth login)"
  fi
fi

say "Shipped"
if [ "$DO_CLIENT" -eq 1 ]; then
  echo "  v$NEXT — already published, nothing to click"
  echo "  https://github.com/zyppn/gunforge-desktop/releases/tag/v$NEXT"
fi
exit 0
