/**
 * Meeting points: the student's usual pick-up / drop-off place, and the
 * places fixed on each lesson when it is booked (see scheduling/places.ts).
 */
import { z } from "zod";
import { many, one, type Tx } from "@/lib/db";
import { ForbiddenError, NotFoundError } from "@/lib/errors";
import { can } from "@/lib/rbac";
import type { Place } from "@/lib/travel";
import { geocoder } from "../geo";
import type { Principal } from "../principal";
import type { Slot } from "../scheduling/engine";
import { planPlaces, type MaybePlace, type PlacedLesson, type PlacePlan } from "../scheduling/places";
import { audit } from "./audit";
import { assertCanViewStudent } from "./students";

const addr = z.string().trim().max(200).optional().transform((v) => v || null);
export const placesSchema = z.object({ pickup: addr, dropoff: addr });

async function locate(address: string | null): Promise<MaybePlace> {
  if (!address) return { address: null, lat: null, lng: null };
  const hit: Place | null = await geocoder().lookup(address);
  // Keep what the person typed; the lookup only adds coordinates.
  return { address, lat: hit?.lat ?? null, lng: hit?.lng ?? null };
}

/** The student (own profile), staff, or the student's instructor sets the usual pick-up and drop-off places. */
export async function setStudentPlaces(tx: Tx, p: Principal, studentId: string, raw: z.input<typeof placesSchema>) {
  if (p.type !== "user") throw new ForbiddenError();
  const self = p.actor.role === "student" && p.actor.studentId === studentId;
  if (!self) {
    if (!can(p.actor.role, "students:write") && p.actor.role !== "instructor") throw new ForbiddenError();
    await assertCanViewStudent(tx, p, studentId);
  }
  const input = placesSchema.parse(raw);
  const [pick, drop] = [await locate(input.pickup), await locate(input.dropoff === input.pickup ? null : input.dropoff)];
  const row = await one<{ id: string }>(
    tx,
    `UPDATE students SET pickup_address = $2, pickup_lat = $3, pickup_lng = $4, dropoff_address = $5, dropoff_lat = $6, dropoff_lng = $7
      WHERE id = $1 RETURNING id`,
    [studentId, pick.address, pick.lat, pick.lng, drop.address, drop.lat, drop.lng],
  );
  if (!row) throw new NotFoundError("Student");
  await audit(tx, p, "student.places_updated", "student", studentId, { located: pick.lat !== null });
  return { pickupFound: !pick.address || pick.lat !== null, dropoffFound: !drop.address || drop.lat !== null };
}

interface StudentPlacesRow { pickup_address: string | null; pickup_lat: number | null; pickup_lng: number | null; dropoff_address: string | null; dropoff_lat: number | null; dropoff_lng: number | null }

async function studentPlaces(tx: Tx, studentId: string) {
  const s = await one<StudentPlacesRow>(tx, `SELECT pickup_address, pickup_lat, pickup_lng, dropoff_address, dropoff_lat, dropoff_lng FROM students WHERE id = $1`, [studentId]);
  return {
    pickup: s ? { address: s.pickup_address, lat: s.pickup_lat, lng: s.pickup_lng } : null,
    dropoff: s?.dropoff_address ? { address: s.dropoff_address, lat: s.dropoff_lat, lng: s.dropoff_lng } : null,
  };
}

interface LessonPlacesRow { id: string; instructor_id: string; start_time: Date; end_time: Date; pickup_address: string | null; pickup_lat: number | null; pickup_lng: number | null; dropoff_address: string | null; dropoff_lat: number | null; dropoff_lng: number | null }

const toPlaced = (l: LessonPlacesRow): PlacedLesson => ({
  start: l.start_time,
  end: l.end_time,
  pickup: { address: l.pickup_address, lat: l.pickup_lat, lng: l.pickup_lng },
  dropoff: { address: l.dropoff_address, lat: l.dropoff_lat, lng: l.dropoff_lng },
});

async function instructorLessons(tx: Tx, instructorIds: string[], from: Date, to: Date, ignore: string[]) {
  return many<LessonPlacesRow>(
    tx,
    `SELECT id, instructor_id, start_time, end_time, pickup_address, pickup_lat, pickup_lng, dropoff_address, dropoff_lat, dropoff_lng
       FROM lessons
      WHERE instructor_id = ANY($1::uuid[]) AND status NOT IN ('cancelled','rescheduled')
        AND start_time < $3 AND end_time > $2 AND NOT (id = ANY($4::uuid[]))`,
    [instructorIds, from, to, ignore],
  );
}

/** Lessons count as "the same day" when they are within 12 hours of each other (an instructor's working day). */
const DAY_REACH = 12 * 3600_000;

function plansFor(student: Awaited<ReturnType<typeof studentPlaces>>, lessons: LessonPlacesRow[], slot: { start: Date; end: Date; instructorId: string }, speedKmh: number): PlacePlan {
  const others = lessons
    .filter((l) => l.instructor_id === slot.instructorId && l.end_time.getTime() > slot.start.getTime() - DAY_REACH && l.start_time.getTime() < slot.end.getTime() + DAY_REACH)
    .map(toPlaced);
  return planPlaces({ studentPickup: student.pickup, studentDropoff: student.dropoff, start: slot.start, end: slot.end, others, speedKmh });
}

async function speed(tx: Tx) {
  return (await one<{ travel_speed_kmh: number }>(tx, `SELECT travel_speed_kmh FROM school_settings`))?.travel_speed_kmh ?? 30;
}

/** For the booking calendar: where each offered time would start and end. */
export async function placePlansForSlots(tx: Tx, studentId: string, slots: Slot[], ignore: string[] = []): Promise<Map<Slot, PlacePlan>> {
  const out = new Map<Slot, PlacePlan>();
  if (slots.length === 0) return out;
  const student = await studentPlaces(tx, studentId);
  const from = new Date(Math.min(...slots.map((s) => s.start.getTime())) - DAY_REACH);
  const to = new Date(Math.max(...slots.map((s) => s.end.getTime())) + DAY_REACH);
  const lessons = await instructorLessons(tx, [...new Set(slots.map((s) => s.instructorId))], from, to, ignore);
  const kmh = await speed(tx);
  for (const s of slots) out.set(s, plansFor(student, lessons, s, kmh));
  return out;
}

/** Fix the start and end place on a lesson that was just booked. */
export async function assignLessonPlaces(tx: Tx, lessonId: string, ignore: string[] = []) {
  const l = await one<{ student_id: string; instructor_id: string; start_time: Date; end_time: Date }>(
    tx, `SELECT student_id, instructor_id, start_time, end_time FROM lessons WHERE id = $1`, [lessonId],
  );
  if (!l) return null;
  const student = await studentPlaces(tx, l.student_id);
  const lessons = await instructorLessons(tx, [l.instructor_id], new Date(l.start_time.getTime() - DAY_REACH), new Date(l.end_time.getTime() + DAY_REACH), [lessonId, ...ignore]);
  const plan = plansFor(student, lessons, { start: l.start_time, end: l.end_time, instructorId: l.instructor_id }, await speed(tx));
  await tx.query(
    `UPDATE lessons SET pickup_address = $2, pickup_lat = $3, pickup_lng = $4, pickup_source = $5,
            dropoff_address = $6, dropoff_lat = $7, dropoff_lng = $8, dropoff_source = $9, travel_minutes_before = $10
      WHERE id = $1`,
    [lessonId, plan.pickup?.address ?? null, plan.pickup?.lat ?? null, plan.pickup?.lng ?? null, plan.pickup ? plan.pickupSource : null,
      plan.dropoff?.address ?? null, plan.dropoff?.lat ?? null, plan.dropoff?.lng ?? null, plan.dropoff ? plan.dropoffSource : null, plan.travelBefore],
  );
  return plan;
}

/** Staff or the lesson's instructor change a lesson's start or end place by hand. */
export async function setLessonPlaces(tx: Tx, p: Principal, lessonId: string, raw: z.input<typeof placesSchema>) {
  if (p.type !== "user") throw new ForbiddenError();
  const l = await one<{ instructor_id: string }>(tx, `SELECT instructor_id FROM lessons WHERE id = $1`, [lessonId]);
  if (!l) throw new NotFoundError("Lesson");
  if (!can(p.actor.role, "lessons:write_all") && !(p.actor.role === "instructor" && p.actor.instructorId === l.instructor_id)) throw new ForbiddenError();
  const input = placesSchema.parse(raw);
  const [pick, drop] = [await locate(input.pickup), await locate(input.dropoff)];
  await tx.query(
    `UPDATE lessons SET pickup_address = $2, pickup_lat = $3, pickup_lng = $4, pickup_source = CASE WHEN $2::text IS NULL THEN NULL ELSE 'staff' END,
            dropoff_address = $5, dropoff_lat = $6, dropoff_lng = $7, dropoff_source = CASE WHEN $5::text IS NULL THEN NULL ELSE 'staff' END
      WHERE id = $1`,
    [lessonId, pick.address, pick.lat, pick.lng, drop.address, drop.lat, drop.lng],
  );
  await audit(tx, p, "lesson.places_updated", "lesson", lessonId);
}
