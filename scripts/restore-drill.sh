#!/usr/bin/env bash
# Restore drill: restores a backup into a NEW throw-away database and checks
# that the data is there. It never touches the live database.
#
#   ADMIN_URL=postgres://postgres:…@host:5432/postgres scripts/restore-drill.sh backups/drivedesk-….dump
#
# Run it monthly and after any change to the backup set-up. Drop the drill
# database afterwards (it holds personal data):  DROP DATABASE <name>;
set -euo pipefail

dump="${1:?usage: restore-drill.sh <backup.dump>}"
: "${ADMIN_URL:?set ADMIN_URL (superuser connection to the postgres database)}"
name="drivedesk_restore_$(date -u +%Y%m%d%H%M)"

# The application roles must exist on the target server for grants to restore;
# on a fresh server run scripts/setup-prod-roles.sh first.
psql "$ADMIN_URL" -v ON_ERROR_STOP=1 -c "CREATE DATABASE $name"
target="${ADMIN_URL%/*}/$name"
pg_restore --no-owner --dbname="$target" "$dump"

psql "$target" -v ON_ERROR_STOP=1 -At <<'SQL'
SELECT 'schools        ' || count(*) FROM schools;
SELECT 'students       ' || count(*) FROM students;
SELECT 'lessons        ' || count(*) FROM lessons;
SELECT 'payments       ' || count(*) FROM payments;
SELECT 'latest lesson  ' || max(created_at) FROM lessons;
SELECT 'latest payment ' || max(created_at) FROM payments;
SELECT 'migrations     ' || string_agg(name, ', ' ORDER BY name) FROM schema_migrations;
SQL
echo "Restored into $name. Compare the counts with production, then: DROP DATABASE $name;"
