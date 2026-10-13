import { execFileSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, openSync } from "node:fs";
import path from "node:path";
import { freshDatabase } from "../../scripts/fresh-db";

const root = path.resolve(import.meta.dirname, "../..");

/** Fresh database + demo seed + production server. Returns the teardown. */
export default async function globalSetup() {
  if (!existsSync(path.join(root, ".next/BUILD_ID"))) throw new Error("Run `npm run build` before the E2E tests.");
  const port = Number(process.env.E2E_PORT ?? 3300);
  const base = `http://localhost:${port}`;
  const db = await freshDatabase(process.env.E2E_DB_NAME ?? "driving_school_e2e");
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    NODE_ENV: "production",
    DATABASE_URL: db.appUrl,
    DATABASE_PLATFORM_URL: db.platformUrl,
    DATABASE_OWNER_URL: db.ownerUrl,
    APP_URL: base,
    EMAIL_PROVIDER: "console",
    // Throw-away secrets for this run only.
    SESSION_SECRET: randomBytes(32).toString("base64"),
    ENCRYPTION_KEY: randomBytes(32).toString("base64"),
    CRON_SECRET: randomBytes(16).toString("hex"),
  };
  try {
    execFileSync(path.join(root, "node_modules/.bin/tsx"), ["scripts/seed.ts"], { cwd: root, env, stdio: "pipe" });
  } catch (err) {
    const e = err as { stdout?: Buffer; stderr?: Buffer };
    throw new Error(`Seeding failed:\n${e.stderr?.toString() ?? ""}${e.stdout?.toString().slice(-2000) ?? ""}`);
  }
  // Server output (including e-mails from the console provider) goes to a log the specs can read.
  mkdirSync(path.join(root, "test-results"), { recursive: true });
  const logFile = path.join(root, "test-results/e2e-server.log");
  const out = openSync(logFile, "w");
  const server = spawn(path.join(root, "node_modules/.bin/next"), ["start", "-p", String(port)], { cwd: root, env, stdio: ["ignore", out, out] });
  process.env.E2E_SERVER_LOG = logFile;
  for (let i = 0; i < 60; i++) {
    const ok = await fetch(`${base}/api/health`).then((r) => r.ok, () => false);
    if (ok) break;
    if (i === 59) throw new Error("E2E server did not start");
    await new Promise((r) => setTimeout(r, 1000));
  }
  // Specs read the database directly for things a person would get by e-mail (reset links).
  process.env.E2E_DB_URL = db.ownerUrl;
  process.env.E2E_CRON_SECRET = env.CRON_SECRET;
  return async () => {
    server.kill();
  };
}
