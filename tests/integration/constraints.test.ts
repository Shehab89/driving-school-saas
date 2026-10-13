/**
 * The database's own rules hold even when application code is bypassed: these
 * statements go straight to SQL as the tenant-scoped application role.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closePools, withTenant } from "@/lib/db";
import { bookLesson } from "@/server/services/lessons";
import { createFixture, slotAt, type Fixture } from "./helpers";

let f: Fixture;
let lessonId: string;

beforeAll(async () => {
  f = await createFixture();
  lessonId = (await withTenant(f.schoolId, (tx) => bookLesson(tx, f.owner, { studentId: f.studentId, slot: slotAt(f, 3, 10), bookedVia: "staff" }))).id;
});
afterAll(closePools);

const insertLesson = (start: string, end: string, price = 5000) =>
  withTenant(f.schoolId, (tx) =>
    tx.query(
      `INSERT INTO lessons (school_id, student_id, instructor_id, start_time, end_time, lesson_number, price_cents, currency)
       VALUES ($1, $2, $3, $4, $5, 99, $6, 'EUR')`,
      [f.schoolId, f.studentId, f.instructorId, start, end, price],
    ),
  );

describe("database constraints under invalid input", () => {
  it("rejects a lesson that ends before it starts, lasts over 8 hours, or has a negative price", async () => {
    // The generated time range refuses it even before the CHECK constraint does.
    await expect(insertLesson("2030-01-01T10:00Z", "2030-01-01T09:00Z")).rejects.toThrow(/check constraint|range lower bound must be less than or equal to range upper bound/);
    await expect(insertLesson("2030-01-01T08:00Z", "2030-01-01T17:00Z")).rejects.toThrow(/check constraint/);
    await expect(insertLesson("2030-01-01T08:00Z", "2030-01-01T09:00Z", -1)).rejects.toThrow(/check constraint/);
  });

  it("refuses illegal status changes, such as reopening a cancelled lesson", async () => {
    await withTenant(f.schoolId, (tx) => tx.query(`UPDATE lessons SET status = 'cancelled', cancelled_at = now() WHERE id = $1`, [lessonId]));
    await expect(
      withTenant(f.schoolId, (tx) => tx.query(`UPDATE lessons SET status = 'scheduled', cancelled_at = NULL WHERE id = $1`, [lessonId])),
    ).rejects.toThrow(/illegal lesson status transition cancelled -> scheduled/);
  });

  it("requires cancelled_at exactly when a lesson is cancelled, and completed_at when completed", async () => {
    await expect(insertLesson("2030-01-02T08:00Z", "2030-01-02T09:00Z").then(() =>
      withTenant(f.schoolId, (tx) => tx.query(`UPDATE lessons SET status = 'cancelled' WHERE start_time = '2030-01-02T08:00Z'`)),
    )).rejects.toThrow(/check constraint/);
    await expect(
      withTenant(f.schoolId, (tx) => tx.query(`UPDATE lessons SET status = 'completed' WHERE start_time = '2030-01-02T08:00Z'`)),
    ).rejects.toThrow(/check constraint/);
  });

  it("rejects malformed phone numbers and unknown statuses", async () => {
    await expect(withTenant(f.schoolId, (tx) => tx.query(`UPDATE students SET phone_e164 = '0612345678' WHERE id = $1`, [f.studentId]))).rejects.toThrow(/check constraint/);
    await expect(withTenant(f.schoolId, (tx) => tx.query(`UPDATE students SET status = 'deleted' WHERE id = $1`, [f.studentId]))).rejects.toThrow(/check constraint/);
  });

  it("rejects a lesson pointing at a student that does not exist", async () => {
    await expect(
      withTenant(f.schoolId, (tx) =>
        tx.query(
          `INSERT INTO lessons (school_id, student_id, instructor_id, start_time, end_time, lesson_number, price_cents, currency)
           VALUES ($1, gen_random_uuid(), $2, '2030-01-03T08:00Z', '2030-01-03T09:00Z', 1, 0, 'EUR')`,
          [f.schoolId, f.instructorId],
        ),
      ),
    ).rejects.toThrow(/foreign key/);
  });
});
