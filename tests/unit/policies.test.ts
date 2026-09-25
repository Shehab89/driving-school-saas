import { describe, expect, it } from "vitest";
import { checkStudentReschedule, noticeDeadline, isLateCancellation } from "@/server/policies";

const tz = "Europe/Amsterdam";
const at = (iso: string) => new Date(iso);

describe("24h reschedule rule", () => {
  // Lesson tomorrow (Fri 20 Sep 2024) at 15:00 Amsterdam (CEST, UTC+2) = 13:00Z
  const lessonStart = at("2024-09-20T13:00:00Z");

  it("allows rescheduling today at 14:00 (25h before)", () => {
    const r = checkStudentReschedule({ lessonStart, status: "scheduled", now: at("2024-09-19T12:00:00Z"), noticeHours: 24, timezone: tz });
    expect(r.allowed).toBe(true);
  });

  it("refuses rescheduling today at 16:00 (23h before)", () => {
    const r = checkStudentReschedule({ lessonStart, status: "scheduled", now: at("2024-09-19T14:00:00Z"), noticeHours: 24, timezone: tz });
    expect(r.allowed).toBe(false);
    if (!r.allowed) expect(r.code).toBe("notice_period_passed");
  });

  it("allows at exactly the deadline", () => {
    const r = checkStudentReschedule({ lessonStart, status: "confirmed", now: at("2024-09-19T13:00:00Z"), noticeHours: 24, timezone: tz });
    expect(r.allowed).toBe(true);
  });

  it("refuses one second after the deadline", () => {
    const r = checkStudentReschedule({ lessonStart, status: "confirmed", now: at("2024-09-19T13:00:01Z"), noticeHours: 24, timezone: tz });
    expect(r.allowed).toBe(false);
  });

  it("refuses completed / cancelled lessons regardless of time", () => {
    for (const status of ["completed", "cancelled", "in_progress", "no_show", "rescheduled"] as const) {
      const r = checkStudentReschedule({ lessonStart, status, now: at("2024-09-01T00:00:00Z"), noticeHours: 24, timezone: tz });
      expect(r.allowed).toBe(false);
    }
  });

  it("uses the school's timezone across a DST change (calendar day, not 24 elapsed hours)", () => {
    // DST ends in Amsterdam on Sun 27 Oct 2024 (03:00 CEST -> 02:00 CET).
    // Lesson Sun 27 Oct 15:00 CET = 14:00Z; deadline is Sat 26 Oct 15:00 CEST = 13:00Z (25 real hours earlier).
    const sunday = at("2024-10-27T14:00:00Z");
    expect(noticeDeadline(sunday, 24, tz).toISOString()).toBe("2024-10-26T13:00:00.000Z");
    // Sat 14:30 local (12:30Z) -> allowed; Sat 15:30 local (13:30Z) -> refused, although 24.5h remain.
    expect(checkStudentReschedule({ lessonStart: sunday, status: "scheduled", now: at("2024-10-26T12:30:00Z"), noticeHours: 24, timezone: tz }).allowed).toBe(true);
    expect(checkStudentReschedule({ lessonStart: sunday, status: "scheduled", now: at("2024-10-26T13:30:00Z"), noticeHours: 24, timezone: tz }).allowed).toBe(false);
  });

  it("honours a configurable notice (48h)", () => {
    expect(noticeDeadline(lessonStart, 48, tz).toISOString()).toBe("2024-09-18T13:00:00.000Z");
    expect(noticeDeadline(lessonStart, 30, tz).toISOString()).toBe("2024-09-19T07:00:00.000Z");
  });

  it("detects late cancellation for fees", () => {
    expect(isLateCancellation({ lessonStart, now: at("2024-09-19T14:00:00Z"), noticeHours: 24, timezone: tz })).toBe(true);
    expect(isLateCancellation({ lessonStart, now: at("2024-09-19T12:00:00Z"), noticeHours: 24, timezone: tz })).toBe(false);
  });
});
