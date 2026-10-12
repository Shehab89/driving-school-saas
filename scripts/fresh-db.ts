/**
 * Recreate a throw-away database (drop, create, login roles, migrate) for
 * end-to-end and load tests. Refuses any name that does not end in _e2e,
 * _load or _test, so it can never wipe a development or production database.
 *
 *   tsx scripts/fresh-db.ts driving_school_e2e
 */
import { execFileSync } from "node:child_process";
import path from "node:path";
import pg from "pg";
import { migrate } from "./migrate";

export interface FreshDb {
  name: string;
  ownerUrl: string;
  appUrl: string;
  platformUrl: string;
}

export async function freshDatabase(name: string, host = process.env.TEST_DB_HOST ?? "localhost:5432", superPassword = process.env.PGPASSWORD ?? "postgres"): Promise<FreshDb> {
  if (!/^[a-z0-9_]+_(e2e|load|test)$/.test(name)) throw new Error(`Refusing to recreate "${name}": only *_e2e, *_load or *_test databases`);
  const admin = new pg.Client({ connectionString: `postgres://postgres:${superPassword}@${host}/postgres` });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
  await admin.query(`CREATE DATABASE ${name}`);
  await admin.end();
  execFileSync(path.resolve(import.meta.dirname, "setup-dev-db.sh"), { env: { ...process.env, DB_NAME: name, PGPASSWORD: superPassword }, stdio: "ignore" });
  const ownerUrl = `postgres://postgres:${superPassword}@${host}/${name}`;
  await migrate(ownerUrl, () => {});
  return {
    name,
    ownerUrl,
    appUrl: `postgres://dsa_app_login:dsa_app_dev@${host}/${name}`,
    platformUrl: `postgres://dsa_platform_login:dsa_platform_dev@${host}/${name}`,
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const name = process.argv[2];
  if (!name) throw new Error("usage: tsx scripts/fresh-db.ts <name_e2e|name_load|name_test>");
  freshDatabase(name).then((d) => console.log(`database ${d.name} ready`), (err) => { console.error(err); process.exit(1); });
}
