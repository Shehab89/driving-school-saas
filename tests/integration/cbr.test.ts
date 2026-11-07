import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closePools, withTenant } from "@/lib/db";
import { ForbiddenError } from "@/lib/errors";
import { cbrStudent, deleteCbrExam, nextCbrExam, saveCbrExam, saveCbrStudent, schoolCbrOverview, studentCbrExams } from "@/server/services/cbr";
import { eraseStudent, exportStudentData } from "@/server/services/privacy";
import { asUser, createFixture, type Fixture } from "./helpers";

let f: Fixture;
let other: Fixture;
const inDays = (n: number) => new Date(Date.now() + n * 86_400_000);

beforeAll(async () => {
  f = await createFixture();
  other = await createFixture();
});
afterAll(closePools);

describe("CBR exams", () => {
  it("records an exam, updates the result and shows it in the overview", async () => {
    const id = await withTenant(f.schoolId, (tx) =>
      saveCbrExam(tx, f.owner, { studentId: f.studentId, product: "practical", status: "reserved", examAt: inDays(40), location: "CBR Utrecht", reservationNumber: "R-123", feeCents: 14350 }),
    );
    expect((await withTenant(f.schoolId, (tx) => nextCbrExam(tx, f.studentId)))?.id).toBe(id);
    let o = await withTenant(f.schoolId, (tx) => schoolCbrOverview(tx, f.owner));
    expect(o.open.map((e) => e.id)).toEqual([id]);
    expect(o.pass.rate).toBeNull();

    await withTenant(f.schoolId, (tx) =>
      saveCbrExam(tx, f.owner, { id, studentId: f.studentId, product: "practical", status: "passed", examAt: inDays(-1), location: "CBR Utrecht", resultNotes: "Rustig gereden" }),
    );
    o = await withTenant(f.schoolId, (tx) => schoolCbrOverview(tx, f.owner));
    expect(o.open).toEqual([]);
    expect(o.pass).toEqual({ rate: 1, taken: 1, passed: 1 });
    expect((await withTenant(f.schoolId, (tx) => nextCbrExam(tx, f.studentId)))).toBeNull();
  });

  it("needs a date unless it is still to reserve", async () => {
    await expect(withTenant(f.schoolId, (tx) => saveCbrExam(tx, f.owner, { studentId: f.studentId, product: "practical", status: "reserved" }))).rejects.toThrow(/date/);
    const id = await withTenant(f.schoolId, (tx) => saveCbrExam(tx, f.owner, { studentId: f.studentId, product: "interim_test", status: "to_reserve" }));
    await withTenant(f.schoolId, (tx) => deleteCbrExam(tx, f.owner, id));
  });

  it("only school staff can record exams; students and instructors cannot", async () => {
    for (const actor of [f.studentActor, f.instructorActor]) {
      await expect(withTenant(f.schoolId, (tx) => saveCbrExam(tx, asUser(actor), { studentId: f.studentId, product: "practical", status: "to_reserve" }))).rejects.toBeInstanceOf(ForbiddenError);
    }
  });

  it("another school cannot see or attach exams to this school's student", async () => {
    await expect(withTenant(other.schoolId, (tx) => saveCbrExam(tx, other.owner, { studentId: f.studentId, product: "practical", status: "to_reserve" }))).rejects.toThrow(/Student/);
    expect(await withTenant(other.schoolId, (tx) => studentCbrExams(tx, f.studentId))).toEqual([]);
  });

  it("keeps the student's CBR checklist, exports it and clears it on erasure", async () => {
    await withTenant(f.schoolId, (tx) => saveCbrStudent(tx, f.owner, f.studentId, { theoryPassedOn: "2026-06-01", health: "approved", authorizedOn: "2026-06-02" }));
    expect(await withTenant(f.schoolId, (tx) => cbrStudent(tx, f.studentId))).toEqual({ cbr_theory_passed_on: "2026-06-01", cbr_health_status: "approved", cbr_authorized_on: "2026-06-02" });
    const data = await withTenant(f.schoolId, (tx) => exportStudentData(tx, f.owner, f.studentId)) as unknown as { cbr_exams: unknown[] };
    expect(data.cbr_exams.length).toBeGreaterThan(0);
    await withTenant(f.schoolId, (tx) => eraseStudent(tx, f.owner, f.studentId, "test"));
    expect(await withTenant(f.schoolId, (tx) => cbrStudent(tx, f.studentId))).toEqual({ cbr_theory_passed_on: null, cbr_health_status: "unknown", cbr_authorized_on: null });
    const exams = await withTenant(f.schoolId, (tx) => studentCbrExams(tx, f.studentId));
    expect(exams.every((e) => e.result_notes === null)).toBe(true);
  });
});
