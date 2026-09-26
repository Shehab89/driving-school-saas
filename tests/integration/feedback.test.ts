import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DateTime } from "luxon";
import { closePools, many, withTenant } from "@/lib/db";
import { bookLesson, completeLesson } from "@/server/services/lessons";
import { feedbackForStudent, feedbackQueue, markFeedbackSeen, saveLessonFeedback, unseenFeedbackCount } from "@/server/services/feedback";
import { asUser, createFixture, setLessonTime, slotAt, type Fixture } from "./helpers";

let f: Fixture;
let lessonId: string;
beforeAll(async () => {
  f = await createFixture();
  const l = await withTenant(f.schoolId, (tx) => bookLesson(tx, f.owner, { studentId: f.studentId, slot: slotAt(f, 25, 9), bookedVia: "staff" }));
  const start = DateTime.now().minus({ days: 1 }).startOf("hour");
  await setLessonTime(f, l.id, start.toJSDate(), start.plus({ hours: 1 }).toJSDate());
  await withTenant(f.schoolId, (tx) => completeLesson(tx, f.owner, l.id, { paymentRequired: false }));
  lessonId = l.id;
});
afterAll(closePools);

describe("instructor feedback → student app", () => {
  it("a completed lesson without feedback waits in the instructor's Feedback tab", async () => {
    const q = await withTenant(f.schoolId, (tx) => feedbackQueue(tx, f.instructorId));
    expect(q.waiting.map((w) => w.lesson_id)).toContain(lessonId);
  });

  it("the lesson's instructor saves feedback; the student sees it as new, without the private note", async () => {
    await withTenant(f.schoolId, (tx) =>
      saveLessonFeedback(tx, asUser(f.instructorActor), lessonId, {
        strengths: "Great mirror checks",
        nextFocus: "Roundabouts",
        instructorNotes: "PRIVATE: parent pays",
        overallRating: 4,
      }),
    );
    const items = await withTenant(f.schoolId, (tx) => feedbackForStudent(tx, f.studentId));
    expect(items[0]).toMatchObject({ strengths: "Great mirror checks", next_focus: "Roundabouts", overall_rating: 4, seen_at: null });
    expect(JSON.stringify(items)).not.toContain("PRIVATE");
    expect(await withTenant(f.schoolId, (tx) => unseenFeedbackCount(tx, f.studentId))).toBe(1);
    const mail = await withTenant(f.schoolId, (tx) => many(tx, `SELECT 1 FROM notifications WHERE lesson_id = $1 AND type = 'feedback_received'`, [lessonId]));
    expect(mail).toHaveLength(1);
  });

  it("opening the Feedback page marks it read; editing makes it new again", async () => {
    await withTenant(f.schoolId, (tx) => markFeedbackSeen(tx, asUser(f.studentActor), f.studentId));
    expect(await withTenant(f.schoolId, (tx) => unseenFeedbackCount(tx, f.studentId))).toBe(0);
    await withTenant(f.schoolId, (tx) => saveLessonFeedback(tx, asUser(f.instructorActor), lessonId, { strengths: "Great mirror checks", nextFocus: "Motorway merge" }));
    expect(await withTenant(f.schoolId, (tx) => unseenFeedbackCount(tx, f.studentId))).toBe(1);
  });

  it("hidden feedback is not shown to the student", async () => {
    await withTenant(f.schoolId, (tx) => saveLessonFeedback(tx, asUser(f.instructorActor), lessonId, { strengths: "Draft", visibleToStudent: false }));
    expect(await withTenant(f.schoolId, (tx) => feedbackForStudent(tx, f.studentId))).toEqual([]);
  });

  it("students and other instructors cannot write feedback", async () => {
    await expect(withTenant(f.schoolId, (tx) => saveLessonFeedback(tx, asUser(f.studentActor), lessonId, { strengths: "x" }))).rejects.toMatchObject({ code: "forbidden" });
    const other = { ...f.instructorActor, instructorId: "00000000-0000-4000-8000-000000000002" };
    await expect(withTenant(f.schoolId, (tx) => saveLessonFeedback(tx, asUser(other), lessonId, { strengths: "x" }))).rejects.toMatchObject({ code: "forbidden" });
  });

  it("feedback needs a lesson that has started", async () => {
    const future = await withTenant(f.schoolId, (tx) => bookLesson(tx, f.owner, { studentId: f.studentId, slot: slotAt(f, 26, 9), bookedVia: "staff" }));
    await expect(withTenant(f.schoolId, (tx) => saveLessonFeedback(tx, asUser(f.instructorActor), future.id, { strengths: "x" }))).rejects.toMatchObject({ code: "invalid_status" });
  });
});
