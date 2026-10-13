import { describe, expect, it } from "vitest";
import { DateTime } from "luxon";
import "@/lib/zone-cache";

/** Reference offset straight from Intl, independent of Luxon. */
function intlOffset(ts: number, zone: string): number {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", { timeZone: zone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" })
      .formatToParts(new Date(ts))
      .map((p) => [p.type, p.value]),
  );
  const asUtc = Date.UTC(+parts.year!, +parts.month! - 1, +parts.day!, +parts.hour!, +parts.minute!, +parts.second!);
  return Math.round((asUtc - Math.floor(ts / 1000) * 1000) / 60_000);
}

describe("cached zone offsets", () => {
  it("match Intl minute by minute across DST changes, in both directions", () => {
    for (const [zone, day] of [
      ["Europe/Amsterdam", "2026-03-29"],
      ["Europe/Amsterdam", "2026-10-25"],
      ["America/New_York", "2026-11-01"],
      ["Australia/Lord_Howe", "2026-04-05"], // 30-minute DST shift
      ["Asia/Kathmandu", "2026-06-01"], // +05:45
    ] as const) {
      const start = DateTime.fromISO(day, { zone }).minus({ hours: 3 }).toMillis();
      for (let ts = start; ts < start + 30 * 3600_000; ts += 60_000) {
        // Twice: the second call is served from the cache.
        expect(DateTime.fromMillis(ts, { zone }).offset, `${zone} ${new Date(ts).toISOString()}`).toBe(intlOffset(ts, zone));
        expect(DateTime.fromMillis(ts, { zone }).offset).toBe(intlOffset(ts, zone));
      }
    }
  });

  it("local wall-clock times still resolve correctly around the spring gap and autumn overlap", () => {
    expect(DateTime.fromISO("2026-03-29T01:30", { zone: "Europe/Amsterdam" }).toUTC().toISO()).toBe("2026-03-29T00:30:00.000Z");
    expect(DateTime.fromISO("2026-03-29T03:30", { zone: "Europe/Amsterdam" }).toUTC().toISO()).toBe("2026-03-29T01:30:00.000Z");
    expect(DateTime.fromISO("2026-10-25T01:30", { zone: "Europe/Amsterdam" }).toUTC().toISO()).toBe("2026-10-24T23:30:00.000Z");
  });
});
