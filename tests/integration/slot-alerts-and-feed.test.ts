import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closePools, many, withPlatform, withTenant } from "@/lib/db";
import { bookLesson, cancelLesson, rescheduleLesson } from "@/server/services/lessons";
import { createStudent } from "@/server/services/students";
import { setEarlierSlotAlert } from "@/server/services/slot-alerts";
import { disableFeed, feedToken, loadFeed, renewFeed } from "@/server/services/calendar-feed";
import { unplannedStudents } from "@/server/services/attention";
import { asUser, createFixture, slotAt, type Fixture } from "./helpers";

let f: Fixture;
let waiting: string; // wants an earlier lesson, next lesson far away
let early: string; // wants one too, but already has an earlier lesson
let quiet: string; // did not switch the alert on
const labels = async () => ({ lesson: "Lesson", instructor: "Instructor", student: "Student", vehicle: "Vehicle", endPoint: "End point" });

const mk = (first: string) =>
  withTenant(f.schoolId, (tx) => createStudent(tx, f.owner, { firstName: first, lastName: "Test", email: `${first.toLowerCase()}-${Date.now()}@example.com`, createLogin: false })).then((s) => s.id);
const book = (studentId: string, days: number, hour: number) =>
  withTenant(f.schoolId, (tx) => bookLesson(tx, f.owner, { studentId, slot: slotAt(f, days, hour), bookedVia: "staff" }));
const offers = () =>
  withPlatform((tx) => many<{ recipient_student_id: string; lesson_id: string }>(tx, `SELECT recipient_student_id, lesson_id FROM notifications WHERE school_id = $1 AND type = 'slot_opened'`, [f.schoolId]));

beforeAll(async () => {
  f = await createFixture();
  waiting = await mk("Wachtend");
  early = await mk("Vroeg");
  quiet = await mk("Stil");
  await withPlatform((tx) => tx.query(`UPDATE students SET earlier_slot_alert = true WHERE id = ANY($1::uuid[])`, [[waiting, early]]));
  await book(waiting, 12, 9);
  await book(early, 2, 9);
});
afterAll(closePools);

describe("earlier-lesson alerts", () => {
  it("a student can switch the alert on for themselves only", async () => {
    await withTenant(f.schoolId, (tx) => setEarlierSlotAlert(tx, asUser(f.studentActor), f.studentId, true));
    await expect(withTenant(f.schoolId, (tx) => setEarlierSlotAlert(tx, asUser(f.studentActor), quiet, true))).rejects.toMatchObject({ code: "forbidden" });
    await expect(withTenant(f.schoolId, (tx) => setEarlierSlotAlert(tx, f.owner, f.studentId, true))).rejects.toMatchObject({ code: "forbidden" });
    await withTenant(f.schoolId, (tx) => setEarlierSlotAlert(tx, asUser(f.studentActor), f.studentId, false));
  });

  it("a cancelled lesson is offered to students waiting for an earlier time, not to the others", async () => {
    const l = await book(f.studentId, 5, 10);
    await withTenant(f.schoolId, (tx) => cancelLesson(tx, f.owner, l.id, "Sick"));
    const sent = await offers();
    expect(sent.filter((n) => n.lesson_id === l.id).map((n) => n.recipient_student_id)).toEqual([waiting]);
  });

  it("the same student is not messaged again within a few hours", async () => {
    const l = await book(f.studentId, 6, 10);
    await withTenant(f.schoolId, (tx) => cancelLesson(tx, f.owner, l.id, "Car broke down"));
    expect((await offers()).filter((n) => n.lesson_id === l.id)).toEqual([]);
  });

  it("moving a lesson to another time offers the old time", async () => {
    await withPlatform((tx) => tx.query(`UPDATE students SET earlier_slot_alert_at = NULL WHERE id = $1`, [waiting]));
    const l = await book(f.studentId, 7, 10);
    await withTenant(f.schoolId, (tx) => rescheduleLesson(tx, f.owner, l.id, slotAt(f, 8, 14), { channel: "staff" }));
    expect((await offers()).filter((n) => n.lesson_id === l.id).map((n) => n.recipient_student_id)).toEqual([waiting]);
  });

  it("no offers when the school does not let students book online", async () => {
    await withPlatform((tx) => tx.query(`UPDATE students SET earlier_slot_alert_at = NULL WHERE id = $1`, [waiting]));
    await withPlatform((tx) => tx.query(`UPDATE school_settings SET student_self_booking = false WHERE school_id = $1`, [f.schoolId]));
    const l = await book(f.studentId, 9, 10);
    await withTenant(f.schoolId, (tx) => cancelLesson(tx, f.owner, l.id, "Holiday"));
    expect((await offers()).filter((n) => n.lesson_id === l.id)).toEqual([]);
    await withPlatform((tx) => tx.query(`UPDATE school_settings SET student_self_booking = true WHERE school_id = $1`, [f.schoolId]));
  });
});

describe("students without a next lesson", () => {
  it("lists active students with nothing planned", async () => {
    const ids = (await withTenant(f.schoolId, (tx) => unplannedStudents(tx, null))).map((s) => s.id);
    expect(ids).toContain(quiet);
    expect(ids).not.toContain(waiting);
    expect(ids).not.toContain(early);
  });
});

describe("calendar link", () => {
  it("shows the instructor's lessons; a wrong, replaced or switched-off link shows nothing", async () => {
    const first = await withTenant(f.schoolId, (tx) => renewFeed(tx, asUser(f.instructorActor)));
    const [, userId, file] = first.match(/\/api\/calendar\/([^/]+)\/([^/]+)\.ics$/)!;
    expect(userId).toBe(f.instructorActor.userId);
    const body = await loadFeed(userId!, file!, labels);
    expect(body).toContain("BEGIN:VCALENDAR");
    expect(body).toMatch(/SUMMARY:Wachtend Test · Lesson \d+/);
    expect(body).not.toContain("Sick"); // cancelled lessons are left out, and so are reasons

    expect(await loadFeed(userId!, "x".repeat(32), labels)).toBeNull();
    await withTenant(f.schoolId, (tx) => renewFeed(tx, asUser(f.instructorActor)));
    expect(await loadFeed(userId!, file!, labels)).toBeNull();
    expect(await loadFeed(userId!, feedToken(userId!, 2), labels)).not.toBeNull();
    await withTenant(f.schoolId, (tx) => disableFeed(tx, asUser(f.instructorActor)));
    expect(await loadFeed(userId!, feedToken(userId!, 2), labels)).toBeNull();
  });

  it("a student's link shows only their own lessons", async () => {
    await book(f.studentId, 10, 15);
    const url = await withTenant(f.schoolId, (tx) => renewFeed(tx, asUser(f.studentActor)));
    const [, userId, file] = url.match(/\/api\/calendar\/([^/]+)\/([^/]+)\.ics$/)!;
    const body = (await loadFeed(userId!, file!, labels))!;
    expect(body).toMatch(/SUMMARY:Lesson \d+ · John/);
    expect(body).not.toContain("Wachtend");
    expect(body).not.toContain("Vroeg");
  });

  it("long lines are folded to 75 bytes as calendar apps expect", async () => {
    const url = await withTenant(f.schoolId, (tx) => renewFeed(tx, asUser(f.ownerActor)));
    const [, userId, file] = url.match(/\/api\/calendar\/([^/]+)\/([^/]+)\.ics$/)!;
    const body = (await loadFeed(userId!, file!, labels))!;
    for (const line of body.split("\r\n")) expect(Buffer.byteLength(line)).toBeLessThanOrEqual(75);
  });
});
