import pg from "pg";
import { env } from "./env";
import { translatePgError } from "./errors";

/**
 * Two pools:
 *  - appPool      : role dsa_app (RLS enforced). All work done on behalf of a
 *                   school user MUST go through withTenant().
 *  - platformPool : role with BYPASSRLS. Only for SaaS-admin screens, routing
 *                   inbound webhooks to a tenant, and system jobs.
 */
type Queryable = Pick<pg.PoolClient, "query">;
export type Tx = Queryable;

const g = globalThis as unknown as { __dsaPools?: { app?: pg.Pool; platform?: pg.Pool } };
g.__dsaPools ??= {};

// Return DATE columns as 'YYYY-MM-DD' strings instead of JS Dates in server local time.
pg.types.setTypeParser(1082, (v) => v);

function appPool(): pg.Pool {
  return (g.__dsaPools!.app ??= new pg.Pool({ connectionString: env.databaseUrl, max: 10 }));
}
function platformPool(): pg.Pool {
  return (g.__dsaPools!.platform ??= new pg.Pool({ connectionString: env.databasePlatformUrl, max: 5 }));
}

async function inTransaction<T>(pool: pg.Pool, setup: (c: pg.PoolClient) => Promise<void>, fn: (tx: Tx) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await setup(client);
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw translatePgError(err);
  } finally {
    client.release();
  }
}

/**
 * Run fn in a transaction bound to one tenant. The setting is transaction-local
 * (set_config(..., true)) so it can never leak to another request that reuses
 * the pooled connection.
 */
export function withTenant<T>(schoolId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  if (!/^[0-9a-f-]{36}$/i.test(schoolId)) throw new Error("withTenant: invalid school id");
  return inTransaction(
    appPool(),
    async (c) => {
      await c.query("SELECT set_config('app.school_id', $1, true)", [schoolId]);
    },
    fn,
  );
}

/** Cross-tenant transaction. Callers must scope every query themselves. */
export function withPlatform<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
  return inTransaction(platformPool(), async () => {}, fn);
}

/** Convenience helpers. */
export async function one<T extends pg.QueryResultRow>(tx: Tx, sql: string, params: unknown[] = []): Promise<T | null> {
  const r = await tx.query<T>(sql, params);
  return r.rows[0] ?? null;
}
export async function many<T extends pg.QueryResultRow>(tx: Tx, sql: string, params: unknown[] = []): Promise<T[]> {
  return (await tx.query<T>(sql, params)).rows;
}

/**
 * Run several queries on one transaction client. A pg client executes one
 * query at a time anyway, so this keeps Promise.all-style destructuring
 * without issuing concurrent queries on the same connection.
 */
export async function sequential<T extends readonly (() => Promise<unknown>)[] | []>(
  thunks: T,
): Promise<{ -readonly [K in keyof T]: Awaited<ReturnType<T[K]>> }> {
  const out: unknown[] = [];
  for (const t of thunks) out.push(await t());
  return out as { -readonly [K in keyof T]: Awaited<ReturnType<T[K]>> };
}

/** For tests / scripts. */
export async function closePools() {
  await Promise.all([g.__dsaPools?.app?.end(), g.__dsaPools?.platform?.end()]);
  g.__dsaPools = {};
}
