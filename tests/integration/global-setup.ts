import pg from "pg";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { migrate } from "../../scripts/migrate";

/** Fresh database per run: drop, create, create login roles, migrate. */
export default async function setup() {
  const db = process.env.TEST_DB_NAME ?? "driving_school_test";
  const host = process.env.TEST_DB_HOST ?? "localhost:5432";
  const admin = new pg.Client({ connectionString: `postgres://postgres:postgres@${host}/postgres` });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS ${db} WITH (FORCE)`);
  await admin.query(`CREATE DATABASE ${db}`);
  await admin.end();
  execFileSync(path.resolve(import.meta.dirname, "../../scripts/setup-dev-db.sh"), {
    env: { ...process.env, DB_NAME: db, PGPASSWORD: "postgres" },
    stdio: "ignore",
  });
  await migrate(`postgres://postgres:postgres@${host}/${db}`, () => {});
}
