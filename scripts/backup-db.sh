#!/usr/bin/env bash
# Logical backup of the whole database (schema, data, roles' grants inside it).
# For self-hosted Postgres (docker compose). Managed Postgres (Railway, Render,
# Neon, RDS…) should use the provider's automatic backups and point-in-time
# recovery instead; run this as an extra, off-site copy if you like.
#
#   DATABASE_OWNER_URL=postgres://… BACKUP_DIR=/var/backups/drivedesk KEEP_DAYS=30 scripts/backup-db.sh
#
# Store BACKUP_DIR on a different machine or bucket than the database. Backups
# contain personal data: encrypt the storage and restrict who can read it.
set -euo pipefail

: "${DATABASE_OWNER_URL:?set DATABASE_OWNER_URL (table owner connection string)}"
BACKUP_DIR="${BACKUP_DIR:-./backups}"
KEEP_DAYS="${KEEP_DAYS:-30}"

mkdir -p "$BACKUP_DIR"
umask 077
file="$BACKUP_DIR/drivedesk-$(date -u +%Y%m%dT%H%M%SZ).dump"
pg_dump --format=custom --compress=9 --no-owner --file="$file.partial" "$DATABASE_OWNER_URL"
mv "$file.partial" "$file"
# A backup that cannot be listed is not a backup.
pg_restore --list "$file" > /dev/null
echo "backup written: $file ($(du -h "$file" | cut -f1))"

find "$BACKUP_DIR" -name 'drivedesk-*.dump' -mtime +"$KEEP_DAYS" -print -delete
