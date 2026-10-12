import { one, withPlatform } from "./db";

/**
 * Fixed-window rate limiter backed by PostgreSQL (table rate_limits), so the
 * limit holds across every app instance. One upsert per check.
 *
 * Records one attempt for `key` and returns true if it is within `limit` hits per `windowMs`.
 */
export async function allow(key: string, limit: number, windowMs: number): Promise<boolean> {
  const row = await withPlatform((tx) =>
    one<{ hits: number }>(
      tx,
      `INSERT INTO rate_limits (key, window_start, hits)
       VALUES ($1, to_timestamp(floor(extract(epoch FROM now()) * 1000 / $2) * $2 / 1000), 1)
       ON CONFLICT (key, window_start) DO UPDATE SET hits = rate_limits.hits + 1
       RETURNING hits`,
      [key, windowMs],
    ),
  );
  return (row?.hits ?? 0) <= limit;
}

/** Delete expired windows. Called from the cron tick. */
export async function sweepRateLimits() {
  await withPlatform((tx) => tx.query(`DELETE FROM rate_limits WHERE window_start < now() - interval '1 day'`));
}

/**
 * Client IP as seen by our own reverse proxy. Proxies append the address they
 * received the request from, so the entries on the left can be anything the
 * client sent; only the last TRUSTED_PROXY_HOPS entries (default 1: one load
 * balancer in front of the app) were written by infrastructure we control.
 */
export function clientIp(h: Headers, trustedHops = Number(process.env.TRUSTED_PROXY_HOPS ?? 1)): string {
  const chain = (h.get("x-forwarded-for") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  if (chain.length && trustedHops > 0) return chain[Math.max(0, chain.length - trustedHops)]!;
  return h.get("x-real-ip") || "unknown";
}
