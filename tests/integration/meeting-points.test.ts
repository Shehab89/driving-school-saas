import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closePools, one, withTenant } from "@/lib/db";
import { setGeocoder } from "@/server/geo";
import { bookLesson } from "@/server/services/lessons";
import { setStudentPlaces } from "@/server/services/meeting-points";
import { createStudent } from "@/server/services/students";
import { bookingGrid } from "@/server/services/reschedule-grid";
import { asUser, createFixture, slotAt, type Fixture } from "./helpers";

const MAP: Record<string, { lat: number; lng: number }> = {
  "Kerkstraat 12, Utrecht": { lat: 52.1, lng: 5.12 },
  "Damrak 1, Amsterdam": { lat: 52.3759, lng: 4.8975 },
  "Biltstraat 5, Utrecht": { lat: 52.0925, lng: 5.13 },
};

let f: Fixture;
let farStudent: string;
beforeAll(async () => {
  setGeocoder({ lookup: async (q) => (MAP[q] ? { address: q, ...MAP[q]! } : null) });
  f = await createFixture();
  farStudent = (await withTenant(f.schoolId, (tx) => createStudent(tx, f.owner, { firstName: "Ver", lastName: "Weg", email: `ver-${Date.now()}@example.com`, createLogin: false }))).id;
});
afterAll(async () => {
  setGeocoder(null);
  await closePools();
});

const lessonPlaces = (id: string) =>
  withTenant(f.schoolId, (tx) =>
    one<{ pickup_address: string | null; pickup_source: string | null; dropoff_address: string | null; dropoff_source: string | null; travel_minutes_before: number | null }>(
      tx, `SELECT pickup_address, pickup_source, dropoff_address, dropoff_source, travel_minutes_before FROM lessons WHERE id = $1`, [id],
    ));

describe("meeting point and end point", () => {
  it("the student saves a pick-up place; an unknown address is kept without a map point", async () => {
    const r = await withTenant(f.schoolId, (tx) => setStudentPlaces(tx, asUser(f.studentActor), f.studentId, { pickup: "Kerkstraat 12, Utrecht", dropoff: "" }));
    expect(r.pickupFound).toBe(true);
    const odd = await withTenant(f.schoolId, (tx) => setStudentPlaces(tx, f.owner, farStudent, { pickup: "Nergenshuizen 1", dropoff: "" }));
    expect(odd.pickupFound).toBe(false);
    await withTenant(f.schoolId, (tx) => setStudentPlaces(tx, f.owner, farStudent, { pickup: "Damrak 1, Amsterdam", dropoff: "" }));
  });

  it("another student cannot change someone else's places", async () => {
    await expect(withTenant(f.schoolId, (tx) => setStudentPlaces(tx, asUser(f.studentActor), farStudent, { pickup: "x", dropoff: "" }))).rejects.toMatchObject({ code: "forbidden" });
  });

  it("a lesson right after another one far away starts where the previous one ends", async () => {
    const first = await withTenant(f.schoolId, (tx) => bookLesson(tx, f.owner, { studentId: f.studentId, slot: slotAt(f, 3, 10), bookedVia: "staff" }));
    expect(await lessonPlaces(first.id)).toMatchObject({ pickup_address: "Kerkstraat 12, Utrecht", pickup_source: "student" });

    // The calendar tells the far-away student before they book.
    const grid = await withTenant(f.schoolId, (tx) => bookingGrid(tx, f.schoolId, farStudent, slotAt(f, 3, 0).start.toISOString().slice(0, 10)));
    const cell = grid.columns.flat().find((c) => c.slotStart === slotAt(f, 3, 11).start.toISOString());
    expect(cell?.places).toMatchObject({ pickupMoved: true, pickup: "Kerkstraat, Utrecht" });

    const second = await withTenant(f.schoolId, (tx) => bookLesson(tx, f.owner, { studentId: farStudent, slot: slotAt(f, 3, 11), bookedVia: "staff" }));
    expect(await lessonPlaces(second.id)).toMatchObject({ pickup_address: "Kerkstraat 12, Utrecht", pickup_source: "previous_lesson", dropoff_address: "Damrak 1, Amsterdam" });
  });

  it("with enough time in between, the instructor drives to the student", async () => {
    await withTenant(f.schoolId, (tx) => setStudentPlaces(tx, f.owner, farStudent, { pickup: "Biltstraat 5, Utrecht", dropoff: "" }));
    const l = await withTenant(f.schoolId, (tx) => bookLesson(tx, f.owner, { studentId: farStudent, slot: slotAt(f, 3, 13), bookedVia: "staff" }));
    const p = await lessonPlaces(l.id);
    expect(p).toMatchObject({ pickup_address: "Biltstraat 5, Utrecht", pickup_source: "student" });
    expect(p!.travel_minutes_before).toBeGreaterThan(0);
  });

  it("the instructor can type the meeting and end point when planning a lesson", async () => {
    const l = await withTenant(f.schoolId, (tx) =>
      bookLesson(tx, asUser(f.instructorActor), { studentId: f.studentId, slot: slotAt(f, 4, 15), bookedVia: "staff", pickupAddress: "Damrak 1, Amsterdam", dropoffAddress: "Biltstraat 5, Utrecht" }),
    );
    expect(await lessonPlaces(l.id)).toMatchObject({ pickup_address: "Damrak 1, Amsterdam", pickup_source: "staff", dropoff_address: "Biltstraat 5, Utrecht", dropoff_source: "staff" });
  });

  it("an instructor may plan a lesson in their own calendar outside working hours", async () => {
    // 21:00 is after the fixture's working hours; the database still refuses overlaps.
    const l = await withTenant(f.schoolId, (tx) =>
      bookLesson(tx, asUser(f.instructorActor), { studentId: farStudent, slot: slotAt(f, 6, 21), bookedVia: "staff", overrideAvailability: true }),
    );
    expect(l.id).toBeTruthy();
  });

  it("a student booking for themselves cannot set someone else's place", async () => {
    const l = await withTenant(f.schoolId, (tx) =>
      bookLesson(tx, asUser(f.studentActor), { studentId: f.studentId, slot: slotAt(f, 5, 15), bookedVia: "student_portal", pickupAddress: "Damrak 1, Amsterdam" }),
    );
    expect(await lessonPlaces(l.id)).toMatchObject({ pickup_address: "Kerkstraat 12, Utrecht", pickup_source: "student" });
  });
});

describe("every lesson has a start and an end place", () => {
  it("a student without an address meets at the school, and lessons booked before get filled in", async () => {
    const { fillMissingLessonPlaces } = await import("@/server/services/meeting-points");
    const { withPlatform } = await import("@/lib/db");
    const noAddr = (await withTenant(f.schoolId, (tx) => createStudent(tx, f.owner, { firstName: "Zonder", lastName: "Adres", email: `zonder-${Date.now()}@example.com`, createLogin: false }))).id;
    // An "old" lesson from before meeting points: no places at all.
    const old = await withTenant(f.schoolId, (tx) => bookLesson(tx, f.owner, { studentId: noAddr, slot: slotAt(f, 9, 8), bookedVia: "staff" }));
    await withPlatform((tx) => tx.query(`UPDATE lessons SET pickup_address = NULL, pickup_source = NULL, dropoff_address = NULL, dropoff_source = NULL WHERE id = $1`, [old.id]));
    // The school has no address yet, so nothing can be filled.
    expect(await withTenant(f.schoolId, (tx) => fillMissingLessonPlaces(tx))).toBe(0);

    await withPlatform((tx) => tx.query(`UPDATE schools SET address = 'Oudegracht 100, Utrecht' WHERE id = $1`, [f.schoolId]));
    expect(await withTenant(f.schoolId, (tx) => fillMissingLessonPlaces(tx))).toBeGreaterThanOrEqual(1);
    expect(await lessonPlaces(old.id)).toMatchObject({ pickup_address: "Oudegracht 100, Utrecht", pickup_source: "school", dropoff_address: "Oudegracht 100, Utrecht", dropoff_source: "school" });

    // Right after it, a student far away: no time to drive, so they start where the first lesson ended.
    const next = await withTenant(f.schoolId, (tx) => bookLesson(tx, f.owner, { studentId: farStudent, slot: slotAt(f, 9, 9), bookedVia: "staff" }));
    expect(await lessonPlaces(next.id)).toMatchObject({ pickup_address: "Oudegracht 100, Utrecht", pickup_source: "previous_lesson" });
  });

  it("no upcoming lesson is left without a start or end place", async () => {
    const { many } = await import("@/lib/db");
    const missing = await withTenant(f.schoolId, (tx) =>
      many(tx, `SELECT id FROM lessons WHERE status IN ('scheduled','confirmed') AND start_time > now() AND (pickup_address IS NULL OR dropoff_address IS NULL)`));
    expect(missing).toEqual([]);
  });
});
