#!/usr/bin/env bash
# Nightly logical backup of the Supabase database, run on the arena server.
#
# Every player's locker, credits and level live in one Supabase project. The Free
# plan takes no automatic backups at all, and even Pro's are only restorable into
# the same project from the dashboard. This keeps our own copies, on a different
# machine from the database, as plain SQL that restores anywhere Postgres runs.
#
# Setup (once, on the Oracle box) - see server/AUTH_SETUP.md, "Backups":
#   sudo apt install postgresql-client-17        # must be >= the project's Postgres major
#   echo 'DB_URL=postgresql://postgres.<ref>:<password>@aws-0-<region>.pooler.supabase.com:5432/postgres' \
#     | sudo tee /etc/gunforge-backup.env && sudo chmod 600 /etc/gunforge-backup.env
#   sudo cp server/ops/gunforge-backup.{service,timer} /etc/systemd/system/
#   sudo systemctl daemon-reload && sudo systemctl enable --now gunforge-backup.timer
#
# Restore into an empty database:   gunzip -c FILE.sql.gz | psql "$NEW_DB_URL"
set -euo pipefail
: "${DB_URL:?DB_URL is not set - see /etc/gunforge-backup.env}"
DIR="${BACKUP_DIR:-/var/backups/gunforge}"
KEEP_DAYS="${KEEP_DAYS:-14}"
mkdir -p "$DIR"
stamp=$(date -u +%Y%m%dT%H%M%SZ)
out="$DIR/gunforge-$stamp.sql.gz"
tmp="$out.partial"

# public schema only: auth.* is Supabase's own, and restoring it by hand is how you
# break GoTrue. Users are re-linked by auth_uid, which is in players.
pg_dump "$DB_URL" --schema=public --no-owner --no-privileges --quote-all-identifiers \
  | gzip -9 > "$tmp"

# A dump that stopped halfway is worse than none: it looks like a backup. Refuse to
# keep anything that does not end with pg_dump's completion marker.
if ! gunzip -c "$tmp" | tail -n 5 | grep -q 'PostgreSQL database dump complete'; then
  rm -f "$tmp"; echo "backup INCOMPLETE - discarded" >&2; exit 1
fi
mv "$tmp" "$out"
find "$DIR" -name 'gunforge-*.sql.gz' -mtime +"$KEEP_DAYS" -delete
echo "backup ok: $out ($(du -h "$out" | cut -f1))"
