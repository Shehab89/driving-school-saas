import { DateTime } from "luxon";
import { one, withPlatform, withTenant } from "@/lib/db";
import type { SchoolActor } from "@/lib/rbac";
import type { Principal } from "@/server/principal";
import { createSchool } from "@/server/services/schools";
import { createInstructor, createVehicle, addAvailabilityRule } from "@/server/services/staff";
import { createStudent } from "@/server/services/students";

let counter = 0;

export interface Fixture {
  schoolId: string;
  timezone: string;
  owner: Principal;
  ownerActor: SchoolActor;
  instructorId: string;
  instructorActor: SchoolActor;
  vehicleId: string;
  studentId: string;
  studentActor: SchoolActor;
}

/** A school with 1 instructor (Mon–Sat 08:00–18:00), 1 manual car, 1 student with a login. */
export async function createFixture(tz = "Europe/Amsterdam"): Promise<Fixture> {
  const n = ++counter;
  const slug = `school-${n}-${Math.random().toString(36).slice(2, 7)}`;
  const school = await createSchool({ name: `School ${n}`, slug, timezone: tz, currency: "EUR", ownerEmail: `owner-${slug}@example.com`, ownerName: "Owner" }, null);
  const schoolId = school.id;

  const ownerUser = await withTenant(schoolId, (tx) => one<{ id: string; email: string }>(tx, `SELECT id, email FROM users WHERE role = 'school_owner'`));
  await withTenant(schoolId, (tx) => tx.query(`UPDATE users SET status = 'active'`));
  const ownerActor: SchoolActor = { userId: ownerUser!.id, role: "school_owner", schoolId, email: ownerUser!.email, instructorId: null, studentId: null };
  const owner: Principal = { type: "user", schoolId, actor: ownerActor };

  return withTenant(schoolId, async (tx) => {
    await tx.query(`UPDATE school_settings SET min_booking_lead_hours = 0, slot_granularity_minutes = 60`);
    await tx.query(`INSERT INTO school_opening_hours (school_id, weekday, opens_at, closes_at) VALUES ($1, 7, '08:00', '18:00')`, [schoolId]);
    await tx.query(`UPDATE school_opening_hours SET opens_at = '08:00', closes_at = '18:00'`);
    const vehicle = await createVehicle(tx, owner, { registrationNumber: `AB-${n}-CD`, brand: "Toyota", model: "Yaris", transmission: "manual" });
    const instructor = await createInstructor(tx, owner, { firstName: "John", lastName: `Smith${n}`, email: `john-${slug}@example.com`, defaultVehicleId: vehicle.id });
    for (let weekday = 1; weekday <= 7; weekday++) {
      await addAvailabilityRule(tx, owner, { instructorId: instructor.id, isRecurring: true, weekday, start: "08:00", end: "18:00" });
    }
    const student = await createStudent(tx, owner, { firstName: "Anna", lastName: `Jansen${n}`, email: `anna-${slug}@example.com`, phone: `+3161234${String(n).padStart(4, "0")}` });
    const iu = await one<{ user_id: string }>(tx, `SELECT user_id FROM instructors WHERE id = $1`, [instructor.id]);
    const su = await one<{ user_id: string }>(tx, `SELECT user_id FROM students WHERE id = $1`, [student.id]);
    await tx.query(`UPDATE users SET status = 'active'`);
    return {
      schoolId,
      timezone: tz,
      owner,
      ownerActor,
      instructorId: instructor.id,
      instructorActor: { userId: iu!.user_id, role: "instructor", schoolId, email: "i@example.com", instructorId: instructor.id, studentId: null },
      vehicleId: vehicle.id,
      studentId: student.id,
      studentActor: { userId: su!.user_id, role: "student", schoolId, email: "s@example.com", instructorId: null, studentId: student.id },
    };
  });
}

export const asUser = (actor: SchoolActor): Principal => ({ type: "user", schoolId: actor.schoolId, actor });

/** A local time N days from now at HH:00 in the zone, as a slot on the fixture's instructor/vehicle. */
export function slotAt(f: Fixture, daysAhead: number, hour: number, minutes = 60) {
  const start = DateTime.now().setZone(f.timezone).plus({ days: daysAhead }).set({ hour, minute: 0, second: 0, millisecond: 0 });
  return { start: start.toJSDate(), end: start.plus({ minutes }).toJSDate(), instructorId: f.instructorId, vehicleId: f.vehicleId };
}

/** Test-only: shift a lesson into the past/future without going through services. */
export async function setLessonTime(f: Fixture, lessonId: string, start: Date, end: Date) {
  await withPlatform((tx) => tx.query(`UPDATE lessons SET start_time = $2, end_time = $3 WHERE id = $1`, [lessonId, start, end]));
}
