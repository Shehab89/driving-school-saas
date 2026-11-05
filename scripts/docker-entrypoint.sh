#!/bin/sh
# Set up database logins (managed Postgres), apply pending migrations (as the owner role), then start.
set -e
# Refuse to start with weak machine secrets (anyone who guesses CRON_SECRET can
# trigger the jobs and read system health).
if [ ${#SESSION_SECRET} -lt 32 ]; then
  echo "SESSION_SECRET must be at least 32 characters (generate one with: openssl rand -base64 32)" >&2
  exit 1
fi
if [ ${#CRON_SECRET} -lt 32 ]; then
  echo "CRON_SECRET must be at least 32 characters (generate one with: openssl rand -base64 32)" >&2
  exit 1
fi
if [ -n "$DATABASE_OWNER_URL" ] && [ -n "$APP_DB_PASSWORD" ] && [ -n "$PLATFORM_DB_PASSWORD" ]; then
  EXPORTS=$(node scripts/bootstrap-roles.ts)
  eval "$EXPORTS"
fi
if [ -n "$DATABASE_OWNER_URL" ] && [ "$SKIP_MIGRATIONS" != "1" ]; then
  node scripts/migrate.ts
  node scripts/bootstrap-admin.ts
fi
# Demo instances only: fill an empty database with the fictional demo schools
# (skipped if they already exist). Never set DEMO_SEED on a real school's server.
if [ "$DEMO_SEED" = "1" ]; then
  if [ -z "$SEED_PASSWORD" ] || [ ${#SEED_PASSWORD} -lt 10 ]; then
    echo "DEMO_SEED=1 needs SEED_PASSWORD (10+ characters) so the demo accounts don't use the public default password" >&2
    exit 1
  fi
  node scripts/demo-seed.mjs
fi
exec "$@"
