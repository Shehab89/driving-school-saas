#!/usr/bin/env bash
# One-time setup for a managed Postgres instance (Render, Railway's "Add
# Postgres" plugin, RDS, etc.) that does NOT run db/init/00-roles.sh for you
# (that only happens automatically for a fresh postgres:16 *container* you
# deploy yourself — see docs/PILOT_DEPLOY.md).
#
# Run this ONCE, before the first deploy, against the admin connection
# string the provider gives you:
#
#   DATABASE_OWNER_URL="postgres://...admin-connection-string..." \
#   APP_DB_PASSWORD="$(openssl rand -base64 24)" \
#   PLATFORM_DB_PASSWORD="$(openssl rand -base64 24)" \
#   ./scripts/setup-prod-roles.sh
#
# It prints the two passwords it used (generate and pass your own, or let it
# generate them) — save them, they become DATABASE_URL / DATABASE_PLATFORM_URL.
# Idempotent: safe to re-run against the same database.
set -euo pipefail

: "${DATABASE_OWNER_URL:?set DATABASE_OWNER_URL to the admin connection string your provider gives you}"
APP_DB_PASSWORD=${APP_DB_PASSWORD:-$(openssl rand -base64 24)}
PLATFORM_DB_PASSWORD=${PLATFORM_DB_PASSWORD:-$(openssl rand -base64 24)}

psql -v ON_ERROR_STOP=1 "$DATABASE_OWNER_URL" <<SQL
DO \$\$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'dsa_app') THEN CREATE ROLE dsa_app NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'dsa_platform') THEN CREATE ROLE dsa_platform NOLOGIN BYPASSRLS; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'dsa_app_login') THEN
    CREATE ROLE dsa_app_login LOGIN PASSWORD '${APP_DB_PASSWORD}' IN ROLE dsa_app;
  ELSE
    ALTER ROLE dsa_app_login PASSWORD '${APP_DB_PASSWORD}';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'dsa_platform_login') THEN
    -- BYPASSRLS is not inherited through role membership, so set it on the login role too.
    CREATE ROLE dsa_platform_login LOGIN BYPASSRLS PASSWORD '${PLATFORM_DB_PASSWORD}' IN ROLE dsa_platform;
  ELSE
    ALTER ROLE dsa_platform_login PASSWORD '${PLATFORM_DB_PASSWORD}';
  END IF;
END\$\$;
SQL

echo
echo "Roles ready. Build the two connection strings from DATABASE_OWNER_URL by swapping"
echo "the user and password only (same host/port/database):"
echo "  DATABASE_URL          -> user dsa_app_login,      password: $APP_DB_PASSWORD"
echo "  DATABASE_PLATFORM_URL -> user dsa_platform_login, password: $PLATFORM_DB_PASSWORD"
