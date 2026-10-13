/**
 * Luxon works out an IANA zone's UTC offset with Intl.DateTimeFormat on every
 * date conversion, which was most of the CPU time of slot searches and the
 * booking calendar. Offsets only change at a zone's transitions, so this
 * caches them per 15-minute window, and only for windows whose offset is the
 * same at both ends, so a window containing a DST change is never cached and
 * every result stays exactly what Luxon would compute.
 */
import { IANAZone } from "luxon";

const WINDOW_MS = 15 * 60_000;
const MAX_ENTRIES = 20_000;
const PATCHED = Symbol.for("drivedesk.zoneOffsetCache");

type Patched = typeof IANAZone.prototype & { [PATCHED]?: true };
const proto = IANAZone.prototype as Patched;

if (!proto[PATCHED]) {
  const uncached = proto.offset;
  const caches = new Map<string, Map<number, number>>();
  proto.offset = function (this: IANAZone, ts: number): number {
    if (!this.isValid || !Number.isFinite(ts)) return uncached.call(this, ts);
    let cache = caches.get(this.name);
    if (!cache) caches.set(this.name, (cache = new Map()));
    const bucket = Math.floor(ts / WINDOW_MS);
    const hit = cache.get(bucket);
    if (hit !== undefined) return hit;
    const start = bucket * WINDOW_MS;
    const atStart = uncached.call(this, start);
    if (uncached.call(this, start + WINDOW_MS - 1) !== atStart) return uncached.call(this, ts);
    if (cache.size >= MAX_ENTRIES) cache.clear();
    cache.set(bucket, atStart);
    return atStart;
  };
  proto[PATCHED] = true;
}
