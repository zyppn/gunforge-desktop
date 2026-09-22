#!/usr/bin/env bash
# ship.sh — one command: test, release the client, deploy the server, verify both.
#
#   ./ship.sh              patch bump   (1.4.46 -> 1.4.47)
#   ./ship.sh minor        1.4.46 -> 1.5.0
#   ./ship.sh 1.5.0        exact version
#   ./ship.sh --server     deploy the server only, no version bump
#   ./ship.sh --client     release the client only, no server deploy
#
# Connection settings live in .deploy.conf (gitignored). First run asks for them.
set -euo pipefail
cd "$(dirname "$0")"
say(){ printf '\n\033[1;33m==> %s\033[0m\n' "$*"; }
die(){ printf '\n\033[1;31mx  %s\033[0m\n' "$*" >&2; exit 1; }

DO_CLIENT=1; DO_SERVER=1; BUMP="patch"
for a in "$@"; do case "$a" in
  --server) DO_CLIENT=0 ;;
  --client) DO_SERVER=0 ;;
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
  read -r -p "  repo path on that box [~/gunforge-desktop] : " P; P="${P:-~/gunforge-desktop}"
  read -r -p "  service name [gunforge] : " S; S="${S:-gunforge}"
  printf 'DEPLOY_HOST=%q\nDEPLOY_PATH=%q\nDEPLOY_SVC=%q\nDEPLOY_PORT=2567\n' "$H" "$P" "$S" > "$CONF"
  echo "  saved to $CONF (gitignored) — you won't be asked again"
fi
# shellcheck disable=SC1090
[ -f "$CONF" ] && . "$CONF"

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
  ssh "$DEPLOY_HOST" "bash -se" <<REMOTE
set -euo pipefail
cd "$DEPLOY_PATH"
git fetch --quiet origin
git reset --hard --quiet "origin/$BRANCH"
# only reinstall when the lockfile actually moved
if ! git diff --quiet HEAD@{1} HEAD -- package-lock.json 2>/dev/null; then
  echo "  lockfile changed — npm ci"
  npm ci --omit=dev --silent
fi
# restart through whatever is actually managing it
if command -v pm2 >/dev/null 2>&1 && pm2 describe "$DEPLOY_SVC" >/dev/null 2>&1; then
  pm2 restart "$DEPLOY_SVC" --update-env >/dev/null && echo "  restarted via pm2"
elif systemctl list-unit-files 2>/dev/null | grep -q "^$DEPLOY_SVC.service"; then
  sudo systemctl restart "$DEPLOY_SVC" && echo "  restarted via systemd"
else
  echo "  !! no pm2 process or systemd unit named '$DEPLOY_SVC' — restart it yourself" >&2
  exit 3
fi
REMOTE

  say "Verify"
  # The box must be running the commit we just pushed. A deploy that silently kept
  # the old code is the failure this whole script exists to prevent.
  REMOTE_SHA="$(ssh "$DEPLOY_HOST" "cd $DEPLOY_PATH && git rev-parse --short HEAD")"
  [ "$REMOTE_SHA" = "$LOCAL" ] || die "box is on $REMOTE_SHA, expected $LOCAL — deploy did not take"
  echo "  box on $REMOTE_SHA"
  HOSTONLY="${DEPLOY_HOST#*@}"
  for i in 1 2 3 4 5 6 7 8 9 10; do
    if (exec 3<>"/dev/tcp/$HOSTONLY/$DEPLOY_PORT") 2>/dev/null; then
      echo "  $HOSTONLY:$DEPLOY_PORT accepting connections"; break
    fi
    [ "$i" -eq 10 ] && die "port $DEPLOY_PORT never came back up"
    sleep 1
  done
fi

say "Shipped"
[ "$DO_CLIENT" -eq 1 ] && echo "  build: https://github.com/zyppn/gunforge-desktop/actions"
[ "$DO_CLIENT" -eq 1 ] && echo "  then publish the release at https://github.com/zyppn/gunforge-desktop/releases"
exit 0
