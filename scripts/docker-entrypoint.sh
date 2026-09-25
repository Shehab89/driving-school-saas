#!/bin/sh
# Apply pending migrations (as the owner role) before starting the server.
set -e
if [ -n "$DATABASE_OWNER_URL" ] && [ "$SKIP_MIGRATIONS" != "1" ]; then
  node scripts/migrate.ts
fi
exec "$@"
