import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DateTime } from "luxon";
import { closePools, withPlatform, withTenant } from "@/lib/db";
import { recordManualPayment, refundPayment } from "@/server/services/billing";
import { bookLesson, completeLesson } from "@/server/services/lessons";
import { createPackage, purchasePackage } from "@/server/services/packages";
import { instructorUtilisation, lessonSummary, parseRange, reconciliationRows, revenueSummary } from "@/server/services/reports";
import { asUser, createFixture, setLessonTime, slotAt, type Fixture } from "./helpers";

let f: Fixture;
let other: Fixture;
const range = () => parseRange(undefined, undefined, "Europe/Amsterdam");

beforeAll(async () => {
  f = await createFixture();
  other = await createFixture();
  // Revenue in another school must never show up here.
  await withTenant(other.schoolId, async (tx) => {
    const pkg = await createPackage(tx, other.owner, { name: "Other", lessonCount: 1, priceCents: 99900 });
    const r = await purchasePackage(tx, other.owner, { studentId: other.studentId, packageId: pkg.id });
    await recordManualPayment(tx, other.owner, r.paymentId, "cash");
  });
});
afterAll(closePools);

describe("revenue", () => {
  it("counts only confirmed money, subtracts refunds, and lists both in the reconciliation export", async () => {
    const pkg = await withTenant(f.schoolId, (tx) => createPackage(tx, f.owner, { name: "Ten", lessonCount: 10, priceCents: 60500 }));
    const before = await withTenant(f.schoolId, (tx) => revenueSummary(tx, range()));
    // One paid package, one still unpaid, one paid and then refunded.
    const paid = await withTenant(f.schoolId, async (tx) => {
      const r = await purchasePackage(tx, f.owner, { studentId: f.studentId, packageId: pkg.id });
      await recordManualPayment(tx, f.owner, r.paymentId, "bank");
      return r.paymentId;
    });
    const pkg2 = await withTenant(f.schoolId, (tx) => createPackage(tx, f.owner, { name: "Two", lessonCount: 2, priceCents: 12000 }));
    await withTenant(f.schoolId, (tx) => purchasePackage(tx, f.owner, { studentId: f.studentId, packageId: pkg2.id }));
    await withTenant(f.schoolId, (tx) => refundPayment(tx, f.owner, paid, "goodwill"));

    const after = await withTenant(f.schoolId, (tx) => revenueSummary(tx, range()));
    expect(after.gross_cents - before.gross_cents).toBe(60500);
    expect(after.refunded_cents - before.refunded_cents).toBe(60500);
    expect(after.net_cents - before.net_cents).toBe(0);
    expect(after.vat_cents - before.vat_cents).toBe(10500);
    expect(after.open_cents + after.overdue_cents - (before.open_cents + before.overdue_cents)).toBe(12000);
    expect(after.gross_cents).toBeLessThan(99900); // nothing from the other school

    const rows = await withTenant(f.schoolId, (tx) => reconciliationRows(tx, range()));
    const mine = rows.filter((r) => r.gross_cents === 60500 || r.gross_cents === -60500);
    expect(mine.map((r) => r.event).sort()).toEqual(["paid", "refunded"]);
    expect(mine.find((r) => r.event === "paid")!.method).toBe("manual");
  });
});

describe("lessons and utilisation", () => {
  it("counts completed lessons and hours against the instructor's availability", async () => {
    // Today's date range only, with a known availability rule for today's weekday.
    const today = DateTime.now().setZone("Europe/Amsterdam");
    const r = parseRange(today.toISODate()!, today.toISODate()!, "Europe/Amsterdam");
    const lesson = await withTenant(f.schoolId, (tx) => bookLesson(tx, f.owner, { studentId: f.studentId, slot: slotAt(f, 9, 10, 120), bookedVia: "staff" }));
    const start = today.set({ hour: 0, minute: 30 }).toJSDate();
    await setLessonTime(f, lesson.id, start, new Date(start.getTime() + 2 * 3600_000));
    await withTenant(f.schoolId, (tx) => completeLesson(tx, asUser(f.instructorActor), lesson.id, {}));

    await withPlatform(async (tx) => {
      await tx.query(`DELETE FROM instructor_availability WHERE instructor_id = $1`, [f.instructorId]);
      await tx.query(
        `INSERT INTO instructor_availability (school_id, instructor_id, is_recurring, weekday, start_time, end_time) VALUES ($1,$2,true,$3,'08:00','16:00')`,
        [f.schoolId, f.instructorId, today.weekday],
      );
    });
    const l = await withTenant(f.schoolId, (tx) => lessonSummary(tx, r));
    expect(l!.completed).toBeGreaterThanOrEqual(1);
    expect(l!.hours_driven).toBeGreaterThanOrEqual(2);
    const u = (await withTenant(f.schoolId, (tx) => instructorUtilisation(tx, r))).find((i) => i.id === f.instructorId)!;
    expect(u.available_hours).toBe(8);
    expect(u.completed_hours).toBe(2);
    expect(u.utilisation).toBe(Math.round((100 * u.booked_hours) / 8));
  });

  it("rejects backwards and over-long ranges", () => {
    expect(() => parseRange("2026-05-02", "2026-05-01", "Europe/Amsterdam")).toThrow(/before/);
    expect(() => parseRange("2024-01-01", "2026-01-01", "Europe/Amsterdam")).toThrow(/one year/);
  });
});
