#!/usr/bin/env bash
# Creates the dev database and the two login roles used by the app.
#   dsa_app_login      -> member of dsa_app      (RLS enforced)  -> DATABASE_URL
#   dsa_platform_login -> member of dsa_platform (BYPASSRLS)     -> DATABASE_PLATFORM_URL
# Migrations run as the superuser / owner                         -> DATABASE_OWNER_URL
set -euo pipefail
DB=${DB_NAME:-driving_school}
PSQL=${PSQL:-"psql -v ON_ERROR_STOP=1 -U postgres -h localhost"}
export PGPASSWORD=${PGPASSWORD:-postgres}

$PSQL -tc "SELECT 1 FROM pg_database WHERE datname='$DB'" | grep -q 1 || $PSQL -c "CREATE DATABASE $DB"
$PSQL -d "$DB" <<SQL
DO \$\$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'dsa_app') THEN CREATE ROLE dsa_app NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'dsa_platform') THEN CREATE ROLE dsa_platform NOLOGIN BYPASSRLS; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'dsa_app_login') THEN
    CREATE ROLE dsa_app_login LOGIN PASSWORD 'dsa_app_dev' IN ROLE dsa_app;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'dsa_platform_login') THEN
    -- BYPASSRLS is not inherited through role membership, so set it on the login role too.
    CREATE ROLE dsa_platform_login LOGIN BYPASSRLS PASSWORD 'dsa_platform_dev' IN ROLE dsa_platform;
  END IF;
END\$\$;
SQL
echo "Database $DB ready."
