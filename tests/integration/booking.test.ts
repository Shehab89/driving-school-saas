import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closePools, many, withTenant } from "@/lib/db";
import { ConflictError } from "@/lib/errors";
import { bookLesson } from "@/server/services/lessons";
import { createStudent } from "@/server/services/students";
import { loadSchoolContext, searchSlots } from "@/server/scheduling/loader";
import { asUser, createFixture, slotAt, type Fixture } from "./helpers";

let f: Fixture;
beforeAll(async () => {
  f = await createFixture();
});
afterAll(closePools);

describe("booking & double-booking prevention", () => {
  it("books an available slot and queues a confirmation e-mail", async () => {
    const lesson = await withTenant(f.schoolId, (tx) => bookLesson(tx, f.owner, { studentId: f.studentId, slot: slotAt(f, 3, 10), bookedVia: "staff" }));
    expect(lesson.status).toBe("scheduled");
    expect(lesson.price_cents).toBe(5500);
    const n = await withTenant(f.schoolId, (tx) => many(tx, `SELECT type FROM notifications WHERE lesson_id = $1`, [lesson.id]));
    expect(n).toEqual([{ type: "lesson_booked" }]);
  });

  it("refuses to double-book the instructor", async () => {
    const other = await withTenant(f.schoolId, (tx) => createStudent(tx, f.owner, { firstName: "Bob", createLogin: false }));
    await expect(
      withTenant(f.schoolId, (tx) => bookLesson(tx, f.owner, { studentId: other.id, slot: slotAt(f, 3, 10), bookedVia: "staff" })),
    ).rejects.toBeInstanceOf(ConflictError);
  });

  it("the database blocks double booking even when availability checks are bypassed", async () => {
    const other = await withTenant(f.schoolId, (tx) => createStudent(tx, f.owner, { firstName: "Carl", createLogin: false }));
    await expect(
      withTenant(f.schoolId, (tx) =>
        bookLesson(tx, f.owner, { studentId: other.id, slot: { ...slotAt(f, 3, 10, 30), vehicleId: null }, bookedVia: "staff", overrideAvailability: true }),
      ),
    ).rejects.toMatchObject({ code: "slot_taken" });
  });

  it("only one of two concurrent bookings for the same instructor slot succeeds", async () => {
    const s1 = await withTenant(f.schoolId, (tx) => createStudent(tx, f.owner, { firstName: "Dan", createLogin: false }));
    const s2 = await withTenant(f.schoolId, (tx) => createStudent(tx, f.owner, { firstName: "Eve", createLogin: false }));
    const slot = slotAt(f, 4, 14);
    const results = await Promise.allSettled([
      withTenant(f.schoolId, (tx) => bookLesson(tx, f.owner, { studentId: s1.id, slot, bookedVia: "staff", overrideAvailability: true })),
      withTenant(f.schoolId, (tx) => bookLesson(tx, f.owner, { studentId: s2.id, slot, bookedVia: "staff", overrideAvailability: true })),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect(rejected.reason).toMatchObject({ code: "slot_taken" });
  });

  it("slot search excludes booked time and numbers lessons chronologically", async () => {
    const slots = await withTenant(f.schoolId, async (tx) => {
      const ctx = await loadSchoolContext(tx, f.schoolId);
      const day = slotAt(f, 3, 0);
      return searchSlots(tx, ctx, { studentId: f.studentId, from: day.start, to: new Date(day.start.getTime() + 24 * 3600_000) });
    });
    const tenOClock = slotAt(f, 3, 10).start.getTime();
    expect(slots.some((s) => s.start.getTime() === tenOClock)).toBe(false);
    expect(slots.length).toBeGreaterThan(0);

    // Book an earlier lesson afterwards: numbering follows time, not booking order.
    await withTenant(f.schoolId, (tx) => bookLesson(tx, f.owner, { studentId: f.studentId, slot: slotAt(f, 2, 9), bookedVia: "staff" }));
    const nums = await withTenant(f.schoolId, (tx) =>
      many<{ lesson_number: number }>(tx, `SELECT lesson_number FROM lessons WHERE student_id = $1 ORDER BY start_time`, [f.studentId]),
    );
    expect(nums.map((n) => n.lesson_number)).toEqual([1, 2]);
  });

  it("a student cannot book for another student", async () => {
    const other = await withTenant(f.schoolId, (tx) => createStudent(tx, f.owner, { firstName: "Fay", createLogin: false }));
    await expect(
      withTenant(f.schoolId, (tx) => bookLesson(tx, asUser(f.studentActor), { studentId: other.id, slot: slotAt(f, 5, 9), bookedVia: "student_portal" })),
    ).rejects.toMatchObject({ code: "forbidden" });
  });
});
