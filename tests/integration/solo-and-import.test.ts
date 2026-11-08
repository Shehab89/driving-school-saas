import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closePools, one, withTenant } from "@/lib/db";
import { createSchool } from "@/server/services/schools";
import { createInstructor, makeOwnerAnInstructor } from "@/server/services/staff";
import { isSoloSchool } from "@/server/services/solo";
import { importStudents } from "@/server/services/student-import";
import { saveCbrExam } from "@/server/services/cbr";
import { bookLesson } from "@/server/services/lessons";
import { parseTable, guessMapping } from "@/lib/student-import";
import type { Principal } from "@/server/principal";
import { createFixture, slotAt, type Fixture } from "./helpers";

let f: Fixture;
beforeAll(async () => {
  f = await createFixture();
});
afterAll(closePools);

describe("one-person school (solo mode)", () => {
  it("is on when the owner is the only instructor, and turns off when someone is hired", async () => {
    const slug = `solo-${Date.now()}`;
    const school = await createSchool({ name: "Rijschool Solo", slug, timezone: "Europe/Amsterdam", currency: "EUR", ownerEmail: `o-${slug}@solo.test`, ownerName: "Sam", planCode: "team" }, null);
    const owner = (await withTenant(school.id, (tx) => one<{ id: string; email: string }>(tx, `SELECT id, email FROM users WHERE role = 'school_owner'`)))!;
    await withTenant(school.id, (tx) => tx.query(`UPDATE users SET status = 'active'`));
    const p: Principal = { type: "user", schoolId: school.id, actor: { userId: owner.id, role: "school_owner", schoolId: school.id, email: owner.email, instructorId: null, studentId: null } };

    expect(await withTenant(school.id, isSoloSchool)).toBe(false); // owner does not teach yet
    await withTenant(school.id, (tx) => makeOwnerAnInstructor(tx, p));
    expect(await withTenant(school.id, isSoloSchool)).toBe(true);
    await withTenant(school.id, (tx) => createInstructor(tx, p, { firstName: "Nina", lastName: "B", email: `nina-${slug}@solo.test` }));
    expect(await withTenant(school.id, isSoloSchool)).toBe(false);
  });

  it("a school with a separate instructor is not solo", async () => {
    expect(await withTenant(f.schoolId, isSoloSchool)).toBe(false);
  });
});

describe("importing students from a previous app or Excel", () => {
  const sheet = [
    "Voornaam\tAchternaam\tE-mail\tTelefoon\tGeboortedatum\tTegoed",
    "Lisa\tde Boer\tlisa@import.test\t0612345678\t31-12-2006\t5",
    "Omar\tHaddad\tomar@import.test\t0687654321\t\t",
    "\tGeen naam\tx@import.test\t\t\t",
    "Kim\tVos\tniet-een-email\t\t\t",
  ].join("\n");

  it("guesses the Dutch columns, creates students, carries lesson credit over and skips bad rows", async () => {
    const table = parseTable(sheet);
    const mapping = guessMapping(table[0]!);
    expect(mapping).toEqual(["firstName", "lastName", "email", "phone", "dateOfBirth", "credits"]);
    const r = await withTenant(f.schoolId, (tx) => importStudents(tx, f.owner, { table, mapping, hasHeader: true, sendInvites: false }));
    expect(r).toMatchObject({ created: 2, skippedExisting: 0, creditsAdded: 5 });
    expect(r.invalid.map((x) => x.error)).toEqual(["name_missing", "email_invalid"]);
    const lisa = await withTenant(f.schoolId, (tx) =>
      one<{ date_of_birth: string; credits: number }>(
        tx,
        `SELECT to_char(s.date_of_birth, 'YYYY-MM-DD') AS date_of_birth, (SELECT coalesce(sum(delta),0)::int FROM student_credit_ledger WHERE student_id = s.id) AS credits
           FROM students s WHERE email = 'lisa@import.test'`,
      ),
    );
    expect(lisa).toEqual({ date_of_birth: "2006-12-31", credits: 5 });
  });

  it("running the same list again does not make doubles", async () => {
    const table = parseTable(sheet);
    const r = await withTenant(f.schoolId, (tx) => importStudents(tx, f.owner, { table, mapping: guessMapping(table[0]!), hasHeader: true, sendInvites: false }));
    expect(r).toMatchObject({ created: 0, skippedExisting: 2 });
  });
});

describe("CBR exam goes straight into the calendar", () => {
  it("books the exam day for the instructor and car", async () => {
    const examAt = slotAt(f, 20, 11).start;
    const id = await withTenant(f.schoolId, (tx) =>
      saveCbrExam(tx, f.owner, { studentId: f.studentId, product: "practical", status: "reserved", examAt, location: "CBR Utrecht", bookCalendar: { instructorId: f.instructorId } }),
    );
    const l = await withTenant(f.schoolId, (tx) =>
      one<{ start_time: Date; end_time: Date; lesson_type: string; vehicle_id: string }>(
        tx, `SELECT l.start_time, l.end_time, l.lesson_type, l.vehicle_id FROM cbr_exams e JOIN lessons l ON l.id = e.lesson_id WHERE e.id = $1`, [id],
      ),
    );
    expect(l!.lesson_type).toBe("exam");
    expect(l!.vehicle_id).toBe(f.vehicleId);
    expect(l!.start_time.getTime()).toBe(examAt.getTime() - 60 * 60_000);
    expect(l!.end_time.getTime() - l!.start_time.getTime()).toBe(120 * 60_000);
  });

  it("refuses when that time is already booked, and saves nothing", async () => {
    const lesson = slotAt(f, 21, 10);
    await withTenant(f.schoolId, (tx) => bookLesson(tx, f.owner, { studentId: f.studentId, slot: lesson, bookedVia: "staff" }));
    const before = await withTenant(f.schoolId, (tx) => one<{ n: number }>(tx, `SELECT count(*)::int AS n FROM cbr_exams`));
    await expect(
      withTenant(f.schoolId, (tx) =>
        saveCbrExam(tx, f.owner, { studentId: f.studentId, product: "practical", status: "reserved", examAt: slotAt(f, 21, 11).start, bookCalendar: { instructorId: f.instructorId } }),
      ),
    ).rejects.toMatchObject({ code: "exam_time_taken" });
    const after = await withTenant(f.schoolId, (tx) => one<{ n: number }>(tx, `SELECT count(*)::int AS n FROM cbr_exams`));
    expect(after!.n).toBe(before!.n);
  });

  it("without the calendar option only the exam is recorded", async () => {
    const id = await withTenant(f.schoolId, (tx) =>
      saveCbrExam(tx, f.owner, { studentId: f.studentId, product: "practical", status: "reserved", examAt: slotAt(f, 21, 11).start }),
    );
    const e = await withTenant(f.schoolId, (tx) => one<{ lesson_id: string | null }>(tx, `SELECT lesson_id FROM cbr_exams WHERE id = $1`, [id]));
    expect(e!.lesson_id).toBeNull();
  });
});
