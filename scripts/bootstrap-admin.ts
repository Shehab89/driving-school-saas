/**
 * Container start-up helper: makes sure one platform (SaaS) admin exists, so
 * a fresh deployment can sign in at /login and create the first school at
 * /platform. Runs after migrations, only when PLATFORM_ADMIN_EMAIL and
 * PLATFORM_ADMIN_PASSWORD are set; does nothing if that e-mail already has
 * an account. Uses the same password-hash format as src/lib/crypto.ts.
 */
import pg from "pg";
import { randomBytes, scrypt as scryptCb } from "node:crypto";
import { promisify } from "node:util";

const scrypt = promisify(scryptCb) as (pw: string, salt: Buffer, len: number, opts: object) => Promise<Buffer>;
const SCRYPT = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

async function hashPassword(password: string) {
  const salt = randomBytes(16);
  const hash = await scrypt(password, salt, 64, SCRYPT);
  return ["scrypt", SCRYPT.N, SCRYPT.r, SCRYPT.p, salt.toString("base64"), hash.toString("base64")].join("$");
}

async function main() {
  const url = process.env.DATABASE_OWNER_URL;
  const email = process.env.PLATFORM_ADMIN_EMAIL?.trim().toLowerCase();
  const password = process.env.PLATFORM_ADMIN_PASSWORD;
  if (!url || !email || !password) return;
  if (password.length < 10) throw new Error("PLATFORM_ADMIN_PASSWORD must be at least 10 characters");

  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    const existing = await client.query("SELECT 1 FROM users WHERE school_id IS NULL AND email = $1", [email]);
    if (existing.rowCount) {
      console.error("[bootstrap] platform admin already exists");
      return;
    }
    await client.query(
      `INSERT INTO users (school_id, role, email, password_hash, status, locale) VALUES (NULL, 'saas_admin', $1, $2, 'active', 'en')`,
      [email, await hashPassword(password)],
    );
    console.error("[bootstrap] platform admin created");
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error("[bootstrap] platform admin failed:", (err as Error).message);
  process.exit(1);
});
