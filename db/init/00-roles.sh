#!/bin/sh
# Runs once when the postgres container initialises its data directory.
# Creates the two login roles the app uses (see README "Database roles").
set -e
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<SQL
CREATE ROLE dsa_app NOLOGIN;
CREATE ROLE dsa_platform NOLOGIN BYPASSRLS;
CREATE ROLE dsa_app_login LOGIN PASSWORD '${APP_DB_PASSWORD}' IN ROLE dsa_app;
CREATE ROLE dsa_platform_login LOGIN BYPASSRLS PASSWORD '${PLATFORM_DB_PASSWORD}' IN ROLE dsa_platform;
SQL
