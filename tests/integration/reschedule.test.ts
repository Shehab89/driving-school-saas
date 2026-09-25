import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DateTime } from "luxon";
import { closePools, one, withTenant } from "@/lib/db";
import { bookLesson, rescheduleLesson, decideRescheduleRequest } from "@/server/services/lessons";
import { asUser, createFixture, setLessonTime, slotAt, type Fixture } from "./helpers";

let f: Fixture;
beforeAll(async () => {
  f = await createFixture();
});
afterAll(closePools);

async function book(daysAhead: number, hour: number) {
  return withTenant(f.schoolId, (tx) => bookLesson(tx, f.owner, { studentId: f.studentId, slot: slotAt(f, daysAhead, hour), bookedVia: "staff" }));
}

describe("student rescheduling", () => {
  it("allows a reschedule more than 24h ahead and supersedes the original", async () => {
    const original = await book(5, 9);
    const res = await withTenant(f.schoolId, (tx) =>
      rescheduleLesson(tx, asUser(f.studentActor), original.id, slotAt(f, 6, 11), { channel: "student_portal", reason: "work" }),
    );
    expect(res.status).toBe("completed");
    const rows = await withTenant(f.schoolId, async (tx) => ({
      old: await one<{ status: string }>(tx, `SELECT status FROM lessons WHERE id = $1`, [original.id]),
      neu: await one<{ status: string; rescheduled_from_id: string; lesson_number: number }>(tx, `SELECT status, rescheduled_from_id, lesson_number FROM lessons WHERE id = $1`, [res.newLessonId]),
      req: await one<{ status: string }>(tx, `SELECT status FROM reschedule_requests WHERE id = $1`, [res.requestId]),
    }));
    expect(rows.old!.status).toBe("rescheduled");
    expect(rows.neu).toMatchObject({ status: "scheduled", rescheduled_from_id: original.id });
    expect(rows.req!.status).toBe("completed");
  });

  it("refuses a student reschedule less than 24h before the lesson (backend rule)", async () => {
    const lesson = await book(7, 9);
    // Move the lesson to 23 hours from now.
    const start = DateTime.now().plus({ hours: 23 }).startOf("hour");
    await setLessonTime(f, lesson.id, start.toJSDate(), start.plus({ hours: 1 }).toJSDate());
    await expect(
      withTenant(f.schoolId, (tx) => rescheduleLesson(tx, asUser(f.studentActor), lesson.id, slotAt(f, 8, 12), { channel: "student_portal" })),
    ).rejects.toMatchObject({ code: "notice_period_passed" });
  });

  it("lets the instructor reschedule inside 24h", async () => {
    const lesson = await book(9, 9);
    const start = DateTime.now().plus({ hours: 20 }).startOf("hour");
    await setLessonTime(f, lesson.id, start.toJSDate(), start.plus({ hours: 1 }).toJSDate());
    const res = await withTenant(f.schoolId, (tx) =>
      rescheduleLesson(tx, asUser(f.instructorActor), lesson.id, slotAt(f, 10, 15), { channel: "staff" }),
    );
    expect(res.status).toBe("completed");
  });

  it("another student cannot reschedule someone else's lesson", async () => {
    const lesson = await book(11, 9);
    const intruder = { ...f.studentActor, studentId: "00000000-0000-4000-8000-000000000000" };
    await expect(
      withTenant(f.schoolId, (tx) => rescheduleLesson(tx, asUser(intruder), lesson.id, slotAt(f, 12, 9), { channel: "student_portal" })),
    ).rejects.toMatchObject({ code: "forbidden" });
  });

  it("uses an approval queue when the school requires it", async () => {
    await withTenant(f.schoolId, (tx) => tx.query(`UPDATE school_settings SET reschedule_requires_approval = true`));
    const lesson = await book(13, 9);
    const res = await withTenant(f.schoolId, (tx) =>
      rescheduleLesson(tx, asUser(f.studentActor), lesson.id, slotAt(f, 14, 10), { channel: "student_portal" }),
    );
    expect(res.status).toBe("pending_approval");
    const newId = await withTenant(f.schoolId, (tx) => decideRescheduleRequest(tx, f.owner, res.requestId, true));
    expect(newId).toBeTruthy();
    await withTenant(f.schoolId, (tx) => tx.query(`UPDATE school_settings SET reschedule_requires_approval = false`));
  });
});
