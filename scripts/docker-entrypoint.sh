#!/bin/sh
# Set up database logins (managed Postgres), apply pending migrations (as the owner role), then start.
set -e
if [ -n "$DATABASE_OWNER_URL" ] && [ -n "$APP_DB_PASSWORD" ] && [ -n "$PLATFORM_DB_PASSWORD" ]; then
  EXPORTS=$(node scripts/bootstrap-roles.ts)
  eval "$EXPORTS"
fi
if [ -n "$DATABASE_OWNER_URL" ] && [ "$SKIP_MIGRATIONS" != "1" ]; then
  node scripts/migrate.ts
  node scripts/bootstrap-admin.ts
fi
exec "$@"
