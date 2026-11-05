import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DateTime } from "luxon";
import { closePools, many, one, withTenant } from "@/lib/db";
import { bookLesson, completeLesson, rescheduleLesson } from "@/server/services/lessons";
import { listTopics, setLessonTopics, topicsForLessons } from "@/server/services/topics";
import { instructorRatings, ownReview, recentReviews, reviewsForLessons, saveLessonReview } from "@/server/services/reviews";
import { instructorOverview, setHourlyRate } from "@/server/services/instructor-stats";
import { createPackage, listPackages, updatePackage } from "@/server/services/packages";
import { exportStudentData } from "@/server/services/privacy";
import { asUser, createFixture, setLessonTime, slotAt, type Fixture } from "./helpers";

let f: Fixture;
let done: string;
let topicIds: string[];
beforeAll(async () => {
  f = await createFixture();
  const l = await withTenant(f.schoolId, (tx) => bookLesson(tx, f.owner, { studentId: f.studentId, slot: slotAt(f, 20, 9), bookedVia: "staff" }));
  const start = DateTime.now().minus({ hours: 3 }).startOf("hour");
  await setLessonTime(f, l.id, start.toJSDate(), start.plus({ hours: 1 }).toJSDate());
  await withTenant(f.schoolId, (tx) => completeLesson(tx, f.owner, l.id, { paymentRequired: false }));
  done = l.id;
  topicIds = (await withTenant(f.schoolId, (tx) => listTopics(tx))).map((t) => t.id);
});
afterAll(closePools);

describe("lesson topics", () => {
  it("the school has topics to choose from (its skills)", () => {
    expect(topicIds.length).toBeGreaterThan(3);
  });

  it("the instructor records the topics practised, several at once", async () => {
    await withTenant(f.schoolId, (tx) => setLessonTopics(tx, asUser(f.instructorActor), done, "covered", topicIds.slice(0, 3)));
    const m = await withTenant(f.schoolId, (tx) => topicsForLessons(tx, [done]));
    expect(m.get(done)!.covered.map((t) => t.id).sort()).toEqual(topicIds.slice(0, 3).sort());
    // Saving again replaces the list.
    await withTenant(f.schoolId, (tx) => setLessonTopics(tx, asUser(f.instructorActor), done, "covered", [topicIds[0]!]));
    expect((await withTenant(f.schoolId, (tx) => topicsForLessons(tx, [done]))).get(done)!.covered).toHaveLength(1);
  });

  it("booking with topics plans them; moving the lesson keeps them", async () => {
    const next = await withTenant(f.schoolId, (tx) =>
      bookLesson(tx, asUser(f.instructorActor), { studentId: f.studentId, slot: { ...slotAt(f, 3, 10), vehicleId: null }, bookedVia: "staff", plannedTopicIds: topicIds.slice(1, 3) }),
    );
    expect((await withTenant(f.schoolId, (tx) => topicsForLessons(tx, [next.id]))).get(next.id)!.planned).toHaveLength(2);
    const moved = await withTenant(f.schoolId, (tx) => rescheduleLesson(tx, f.owner, next.id, slotAt(f, 4, 11), { channel: "staff" }));
    expect((await withTenant(f.schoolId, (tx) => topicsForLessons(tx, [moved.newLessonId!]))).get(moved.newLessonId!)!.planned.map((t) => t.id).sort()).toEqual(topicIds.slice(1, 3).sort());
  });

  it("students, other instructors and unknown topics are refused", async () => {
    await expect(withTenant(f.schoolId, (tx) => setLessonTopics(tx, asUser(f.studentActor), done, "covered", []))).rejects.toMatchObject({ code: "forbidden" });
    const other = { ...f.instructorActor, instructorId: "00000000-0000-4000-8000-000000000002" };
    await expect(withTenant(f.schoolId, (tx) => setLessonTopics(tx, asUser(other), done, "covered", []))).rejects.toMatchObject({ code: "forbidden" });
    await expect(withTenant(f.schoolId, (tx) => setLessonTopics(tx, f.owner, done, "covered", ["00000000-0000-4000-8000-000000000009"]))).rejects.toMatchObject({ code: "validation_error" });
  });
});

describe("student reviews", () => {
  it("the student reviews their completed lesson; the school sees it, with the instructor's average", async () => {
    await withTenant(f.schoolId, (tx) => saveLessonReview(tx, asUser(f.studentActor), done, { rating: 4, comment: "Very patient" }));
    expect(await withTenant(f.schoolId, (tx) => ownReview(tx, asUser(f.studentActor), done))).toMatchObject({ rating: 4, comment: "Very patient" });
    // A second save updates it.
    await withTenant(f.schoolId, (tx) => saveLessonReview(tx, asUser(f.studentActor), done, { rating: 5, comment: "" }));
    const staff = await withTenant(f.schoolId, (tx) => reviewsForLessons(tx, f.owner, [done]));
    expect(staff.get(done)).toMatchObject({ rating: 5, comment: null });
    expect((await withTenant(f.schoolId, (tx) => instructorRatings(tx, f.owner))).get(f.instructorId)).toEqual({ avg: 5, count: 1 });
    expect(await withTenant(f.schoolId, (tx) => recentReviews(tx, f.owner, f.instructorId))).toHaveLength(1);
  });

  it("instructors do not see reviews", async () => {
    expect((await withTenant(f.schoolId, (tx) => reviewsForLessons(tx, asUser(f.instructorActor), [done]))).size).toBe(0);
    await expect(withTenant(f.schoolId, (tx) => instructorRatings(tx, asUser(f.instructorActor)))).rejects.toMatchObject({ code: "forbidden" });
  });

  it("only the lesson's own student, only after the lesson, rating 1–5", async () => {
    const future = await withTenant(f.schoolId, (tx) => bookLesson(tx, f.owner, { studentId: f.studentId, slot: slotAt(f, 9, 9), bookedVia: "staff" }));
    await expect(withTenant(f.schoolId, (tx) => saveLessonReview(tx, asUser(f.studentActor), future.id, { rating: 3 }))).rejects.toMatchObject({ code: "invalid_status" });
    await expect(withTenant(f.schoolId, (tx) => saveLessonReview(tx, asUser(f.instructorActor), done, { rating: 3 }))).rejects.toMatchObject({ code: "forbidden" });
    const other = { ...f.studentActor, studentId: "00000000-0000-4000-8000-000000000003" };
    await expect(withTenant(f.schoolId, (tx) => saveLessonReview(tx, asUser(other), done, { rating: 3 }))).rejects.toMatchObject({ code: "not_found" });
    await expect(withTenant(f.schoolId, (tx) => saveLessonReview(tx, asUser(f.studentActor), done, { rating: 6 }))).rejects.toThrow();
  });

  it("reviews are part of the student's data export", async () => {
    const data = await withTenant(f.schoolId, (tx) => exportStudentData(tx, f.owner, f.studentId));
    expect((data as { lesson_reviews: unknown[] }).lesson_reviews).toHaveLength(1);
  });
});

describe("instructor overview and pay", () => {
  it("shows working hours, booked time, rating and pay for hours taught", async () => {
    await withTenant(f.schoolId, (tx) => setHourlyRate(tx, f.owner, f.instructorId, 3000));
    const o = await withTenant(f.schoolId, (tx) => instructorOverview(tx, f.owner, f.instructorId, f.timezone));
    expect(o.days).toHaveLength(7);
    expect(o.week.available).toBe(70);
    expect(o.rating).toEqual({ avg: 5, count: 1 });
    const taughtThisMonth = DateTime.now().setZone(f.timezone).minus({ hours: 3 }).hasSame(DateTime.now().setZone(f.timezone), "month");
    expect(o.month.payCents).toBe(taughtThisMonth ? 3000 : 0);
  });

  it("only the owner sets the rate; instructors cannot open the overview", async () => {
    const admin = { ...f.ownerActor, role: "school_admin" as const };
    await expect(withTenant(f.schoolId, (tx) => setHourlyRate(tx, asUser(admin), f.instructorId, 100))).rejects.toMatchObject({ code: "forbidden" });
    await expect(withTenant(f.schoolId, (tx) => instructorOverview(tx, asUser(f.instructorActor), f.instructorId, f.timezone))).rejects.toMatchObject({ code: "forbidden" });
  });
});

describe("price bundles", () => {
  it("the owner builds and edits packages, with or without the exam", async () => {
    const p = await withTenant(f.schoolId, (tx) => createPackage(tx, f.owner, { name: "Exam bundle", lessonCount: 20, priceCents: 129000, includesExam: true }));
    await withTenant(f.schoolId, (tx) => updatePackage(tx, f.owner, p.id, { name: "Exam bundle XL", lessonCount: 25, priceCents: 149000, includesExam: true, soldOnline: false }));
    const row = (await withTenant(f.schoolId, (tx) => listPackages(tx))).find((x) => x.id === p.id);
    expect(row).toMatchObject({ name: "Exam bundle XL", lesson_count: 25, price_cents: 149000, includes_exam: true, sold_online: false });
    await expect(withTenant(f.schoolId, (tx) => updatePackage(tx, asUser(f.instructorActor), p.id, { name: "x", lessonCount: 1, priceCents: 1 }))).rejects.toMatchObject({ code: "forbidden" });
  });
});

describe("tenant isolation", () => {
  it("topics and reviews of another school are invisible", async () => {
    const g = await createFixture();
    const seen = await withTenant(g.schoolId, (tx) => many(tx, `SELECT 1 FROM lesson_reviews UNION ALL SELECT 1 FROM lesson_topics`));
    expect(seen).toHaveLength(0);
    expect(await withTenant(g.schoolId, (tx) => one(tx, `SELECT 1 FROM lesson_topics WHERE lesson_id = $1`, [done]))).toBeNull();
  });
});
