import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DateTime } from "luxon";
import { closePools, one, withTenant } from "@/lib/db";
import { bookLesson, rescheduleLesson } from "@/server/services/lessons";
import { rescheduleGrid, type RescheduleGrid } from "@/server/services/reschedule-grid";
import { createStudent } from "@/server/services/students";
import { asUser, createFixture, setLessonTime, slotAt, type Fixture } from "./helpers";

let f: Fixture;
let otherStudentId: string;
beforeAll(async () => {
  f = await createFixture();
  otherStudentId = (await withTenant(f.schoolId, (tx) => createStudent(tx, f.owner, { firstName: "Bo", lastName: "Other", email: `bo-${f.schoolId}@example.com`, phone: "+31699999999" }))).id;
});
afterAll(closePools);

const book = (studentId: string, days: number, hour: number) =>
  withTenant(f.schoolId, (tx) => bookLesson(tx, f.owner, { studentId, slot: slotAt(f, days, hour), bookedVia: "staff" }));
const grid = (lessonId: string, start?: string) => withTenant(f.schoolId, (tx) => rescheduleGrid(tx, f.schoolId, f.studentId, lessonId, start));
const cell = (g: RescheduleGrid, days: number, hhmm: string) => {
  const iso = DateTime.now().setZone(f.timezone).plus({ days }).toISODate()!;
  return g.cells[g.times.indexOf(hhmm)]![g.days.indexOf(iso)]!;
};

describe("reschedule week table", () => {
  it("shows the week of the lesson: the current time, free times in the instructor's hours and times others booked as taken", async () => {
    const mine = await book(f.studentId, 5, 10);
    await book(otherStudentId, 5, 13);
    const g = await grid(mine.id);
    expect(g.allowed).toBe(true);
    expect(g.times[0]).toBe("08:00");
    expect(g.times.at(-1)).toBe("17:00");
    expect(cell(g, 5, "10:00").state).toBe("current");
    expect(cell(g, 5, "13:00").state).toBe("taken");
    expect(cell(g, 5, "11:00")).toMatchObject({ state: "free" });
    expect(cell(g, 5, "11:00").slot).toContain(f.instructorId);
  });

  it("a green cell books through rescheduleLesson and the table reflects the database afterwards", async () => {
    const mine = await book(f.studentId, 7, 9);
    const g = await grid(mine.id);
    const target = cell(g, 7, "15:00");
    expect(target.state).toBe("free");
    const [start, end, instructorId, vehicleId] = target.slot!.split("|");
    const r = await withTenant(f.schoolId, (tx) =>
      rescheduleLesson(tx, asUser(f.studentActor), mine.id, { start: new Date(start!), end: new Date(end!), instructorId: instructorId!, vehicleId: vehicleId || null }, { channel: "student_portal" }),
    );
    expect(r.status).toBe("completed");
    const moved = await withTenant(f.schoolId, (tx) => one<{ start_time: Date; status: string }>(tx, `SELECT start_time, status FROM lessons WHERE id = $1`, [r.newLessonId]));
    expect(moved!.start_time.toISOString()).toBe(new Date(start!).toISOString());
    const after = await grid(r.newLessonId!);
    expect(cell(after, 7, "15:00").state).toBe("current");
    expect(cell(after, 7, "09:00").state).toBe("free"); // the old time is released
  });

  it("if someone takes a green time before the student confirms, the booking is refused and the cell turns grey", async () => {
    const mine = await book(f.studentId, 9, 9);
    const stale = cell(await grid(mine.id), 9, "12:00");
    expect(stale.state).toBe("free");
    await book(otherStudentId, 9, 12);
    const [start, end, instructorId, vehicleId] = stale.slot!.split("|");
    await expect(
      withTenant(f.schoolId, (tx) =>
        rescheduleLesson(tx, asUser(f.studentActor), mine.id, { start: new Date(start!), end: new Date(end!), instructorId: instructorId!, vehicleId: vehicleId || null }, { channel: "student_portal" }),
      ),
    ).rejects.toMatchObject({ code: "slot_taken" });
    expect(cell(await grid(mine.id), 9, "12:00").state).toBe("taken");
  });

  it("the student's own other lessons are marked, and weeks can be paged", async () => {
    const a = await book(f.studentId, 11, 9);
    await book(f.studentId, 11, 14);
    const g = await grid(a.id);
    expect(cell(g, 11, "14:00").state).toBe("mine");
    expect(g.prevStart).not.toBeNull();
    const next = await grid(a.id, g.nextStart!);
    expect(next.days[0]).toBe(g.nextStart);
  });

  it("inside the notice period nothing is offered", async () => {
    const soon = await book(f.studentId, 30, 9);
    const start = DateTime.now().plus({ hours: 3 }).startOf("hour");
    await setLessonTime(f, soon.id, start.toJSDate(), start.plus({ hours: 1 }).toJSDate());
    const g = await grid(soon.id);
    expect(g.allowed).toBe(false);
    expect(g.freeCount).toBe(0);
    expect(g.cells.flat().some((c) => c.state === "free")).toBe(false);
  });

  it("a student cannot open another student's lesson", async () => {
    const theirs = await book(otherStudentId, 12, 10);
    await expect(grid(theirs.id)).rejects.toMatchObject({ code: "not_found" });
  });
});
