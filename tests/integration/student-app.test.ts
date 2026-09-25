import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closePools, withTenant } from "@/lib/db";
import { bookLesson } from "@/server/services/lessons";
import { applyProgressUpdate, getProgressSummary } from "@/server/services/progress";
import { asUser, createFixture, slotAt, type Fixture } from "./helpers";

let f: Fixture;
beforeAll(async () => {
  f = await createFixture();
});
afterAll(closePools);

describe("student app rules", () => {
  it("a student can book an available slot for themselves", async () => {
    const lesson = await withTenant(f.schoolId, (tx) => bookLesson(tx, asUser(f.studentActor), { studentId: f.studentId, slot: slotAt(f, 6, 10), bookedVia: "student_portal" }));
    expect((lesson as unknown as { booked_via: string }).booked_via).toBe("student_portal");
  });

  it("the server refuses student self-booking when the school turned it off", async () => {
    await withTenant(f.schoolId, (tx) => tx.query(`UPDATE school_settings SET student_self_booking = false`));
    await expect(
      withTenant(f.schoolId, (tx) => bookLesson(tx, asUser(f.studentActor), { studentId: f.studentId, slot: slotAt(f, 7, 10), bookedVia: "student_portal" })),
    ).rejects.toMatchObject({ code: "self_booking_disabled" });
    // Staff can still book for the student.
    await withTenant(f.schoolId, (tx) => bookLesson(tx, f.owner, { studentId: f.studentId, slot: slotAt(f, 7, 10), bookedVia: "staff" }));
    await withTenant(f.schoolId, (tx) => tx.query(`UPDATE school_settings SET student_self_booking = true`));
  });

  it("level and skill names follow the viewer's language", async () => {
    const levelId = await withTenant(f.schoolId, async (tx) => (await tx.query<{ id: string }>(`SELECT id FROM level_definitions WHERE position = 3`)).rows[0]!.id);
    await withTenant(f.schoolId, (tx) => applyProgressUpdate(tx, f.owner, { studentId: f.studentId, lessonId: null, skills: [], newLevelId: levelId }));
    const [en, nl, ar] = await Promise.all([
      withTenant(f.schoolId, (tx) => getProgressSummary(tx, f.studentId, "en")),
      withTenant(f.schoolId, (tx) => getProgressSummary(tx, f.studentId, "nl")),
      withTenant(f.schoolId, (tx) => getProgressSummary(tx, f.studentId, "ar")),
    ]);
    expect(en.currentLevel!.name).toBe("Level 3 – Urban driving");
    expect(nl.currentLevel!.name).toBe("Niveau 3 – Rijden in de stad");
    expect(ar.currentLevel!.name).toBe("المستوى 3 – القيادة في المدينة");
    expect(nl.skills.map((s) => s.name)).toContain("Rotondes");
  });
});
