import "server-only";
/**
 * A small in-memory sliding-window limiter for a single Next.js instance.
 * Good enough to blunt credential-stuffing and brute-force login attempts
 * during a pilot; it does not coordinate across processes, so if the app is
 * ever scaled to multiple instances this should move to Redis or similar.
 */
const buckets = new Map<string, number[]>();

// Keep the map from growing forever if it's never swept otherwise.
let lastSweep = Date.now();
function sweep(windowMs: number) {
  const now = Date.now();
  if (now - lastSweep < 60_000) return;
  lastSweep = now;
  for (const [key, hits] of buckets) {
    const kept = hits.filter((t) => now - t < windowMs);
    if (kept.length === 0) buckets.delete(key);
    else buckets.set(key, kept);
  }
}

/** Records one attempt for `key` and returns true if it is within `limit` hits per `windowMs`. */
export function allow(key: string, limit: number, windowMs: number): boolean {
  sweep(windowMs);
  const now = Date.now();
  const hits = (buckets.get(key) ?? []).filter((t) => now - t < windowMs);
  hits.push(now);
  buckets.set(key, hits);
  return hits.length <= limit;
}
