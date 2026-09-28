/**
 * Container start-up helper for managed Postgres (Render, Railway, …).
 *
 * When APP_DB_PASSWORD and PLATFORM_DB_PASSWORD are set, it makes sure the
 * two login roles exist with those passwords (same as
 * scripts/setup-prod-roles.sh, idempotent), using DATABASE_OWNER_URL. If
 * DATABASE_URL / DATABASE_PLATFORM_URL are not set, it prints `export` lines
 * that build them from DATABASE_OWNER_URL by swapping only user and password,
 * so a platform only needs its one admin connection string.
 *
 * Used by scripts/docker-entrypoint.sh as:  eval "$(node scripts/bootstrap-roles.ts)"
 * Everything except the export lines goes to stderr.
 */
import pg from "pg";

async function main() {
  const owner = process.env.DATABASE_OWNER_URL;
  const appPw = process.env.APP_DB_PASSWORD;
  const platformPw = process.env.PLATFORM_DB_PASSWORD;
  if (!owner || !appPw || !platformPw) return;

  const client = new pg.Client({ connectionString: owner });
  await client.connect();
  try {
    const lit = (s: string) => client.escapeLiteral(s);
    const exists = async (role: string) => (await client.query("SELECT 1 FROM pg_roles WHERE rolname = $1", [role])).rowCount! > 0;
    if (!(await exists("dsa_app"))) await client.query("CREATE ROLE dsa_app NOLOGIN");
    if (!(await exists("dsa_platform"))) await client.query("CREATE ROLE dsa_platform NOLOGIN BYPASSRLS");
    if (!(await exists("dsa_app_login"))) await client.query(`CREATE ROLE dsa_app_login LOGIN PASSWORD ${lit(appPw)} IN ROLE dsa_app`);
    else await client.query(`ALTER ROLE dsa_app_login PASSWORD ${lit(appPw)}`);
    // BYPASSRLS is not inherited through role membership, so it goes on the login role too.
    if (!(await exists("dsa_platform_login"))) await client.query(`CREATE ROLE dsa_platform_login LOGIN BYPASSRLS PASSWORD ${lit(platformPw)} IN ROLE dsa_platform`);
    else await client.query(`ALTER ROLE dsa_platform_login PASSWORD ${lit(platformPw)}`);
    console.error("[bootstrap] database login roles ready");
  } finally {
    await client.end();
  }

  const derive = (user: string, password: string) => {
    const u = new URL(owner);
    u.username = user;
    u.password = password;
    return u.toString();
  };
  const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
  if (!process.env.DATABASE_URL) console.log(`export DATABASE_URL=${q(derive("dsa_app_login", appPw))}`);
  if (!process.env.DATABASE_PLATFORM_URL) console.log(`export DATABASE_PLATFORM_URL=${q(derive("dsa_platform_login", platformPw))}`);
}

main().catch((err) => {
  console.error("[bootstrap] failed:", (err as Error).message);
  process.exit(1);
});
