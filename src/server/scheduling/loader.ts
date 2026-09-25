/**
 * Loads everything the scheduling engine needs for one student from the
 * database (inside a tenant transaction) and runs it.
 */
import { DateTime } from "luxon";
import { many, one, sequential, type Tx } from "@/lib/db";
import { NotFoundError } from "@/lib/errors";
import { findAvailableSlots, isSlotAvailable, type Slot, type SlotSearchInput, type TimeRange } from "./engine";

export interface SchoolSchedulingContext {
  schoolId: string;
  timezone: string;
  currency: string;
  settings: SchoolSettingsRow;
}

export interface SchoolSettingsRow {
  min_reschedule_notice_hours: number;
  min_cancellation_notice_hours: number;
  late_cancellation_fee_cents: number;
  min_booking_lead_hours: number;
  booking_horizon_days: number;
  default_lesson_minutes: number;
  default_lesson_price_cents: number;
  slot_granularity_minutes: number;
  buffer_minutes: number;
  payment_due_days: number;
  auto_payment_request: boolean;
  reminder_hours_before: number;
  reschedule_requires_approval: boolean;
  ai_agent_enabled: boolean;
  ai_agent_can_book: boolean;
  student_self_booking: boolean;
  school_info_for_agent: string | null;
}

export async function loadSchoolContext(tx: Tx, schoolId: string): Promise<SchoolSchedulingContext> {
  const row = await one<{ timezone: string; currency: string } & SchoolSettingsRow>(
    tx,
    `SELECT s.timezone, s.currency, ss.*
       FROM schools s JOIN school_settings ss ON ss.school_id = s.id
      WHERE s.id = $1`,
    [schoolId],
  );
  if (!row) throw new NotFoundError("School settings");
  const { timezone, currency, ...settings } = row;
  return { schoolId, timezone, currency, settings: settings as SchoolSettingsRow };
}

/** Database clock, so rules never depend on the app server's clock. */
export async function dbNow(tx: Tx): Promise<Date> {
  return (await one<{ now: Date }>(tx, "SELECT now() AS now"))!.now;
}

interface StudentRow {
  id: string;
  license_category: string;
  preferred_transmission: "manual" | "automatic";
  primary_instructor_id: string | null;
  status: string;
}

export interface SlotQuery {
  studentId: string;
  from?: Date;
  to?: Date;
  durationMinutes?: number;
  instructorIds?: string[];
  /** Lessons to ignore as "busy" (the lesson being rescheduled). */
  ignoreLessonIds?: string[];
  /** Staff may search without the student's preferred-time filter / lead time. */
  ignoreStudentPreferences?: boolean;
  ignoreLeadTime?: boolean;
  distinctTimes?: boolean;
  maxSlots?: number;
  now?: Date;
}

const ACTIVE_LESSON = "status NOT IN ('cancelled','rescheduled')";

function ranges(rows: { start_time: Date; end_time: Date }[]): TimeRange[] {
  return rows.map((r) => ({ start: r.start_time, end: r.end_time }));
}

export async function buildSlotSearchInput(
  tx: Tx,
  ctx: SchoolSchedulingContext,
  q: SlotQuery,
): Promise<SlotSearchInput> {
  const now = q.now ?? (await dbNow(tx));
  const s = ctx.settings;
  const from = q.from ?? now;
  const to = q.to ?? DateTime.fromJSDate(now).plus({ days: s.booking_horizon_days }).toJSDate();
  const ignore = q.ignoreLessonIds ?? [];

  const student = await one<StudentRow>(
    tx,
    `SELECT id, license_category, preferred_transmission, primary_instructor_id, status FROM students WHERE id = $1`,
    [q.studentId],
  );
  if (!student) throw new NotFoundError("Student");

  const [opening, closures, instructors, vehicles, studentPrefs, studentBusy] = await sequential([
    () => many<{ weekday: number; opens_at: string; closes_at: string }>(
      tx,
      `SELECT weekday, opens_at::text, closes_at::text FROM school_opening_hours`,
    ),
    () => many<{ starts_on: string; ends_on: string }>(
      tx,
      `SELECT starts_on::text, ends_on::text FROM school_closures WHERE ends_on >= $1::date - 1 AND starts_on <= $2::date + 1`,
      [from, to],
    ),
    () => many<{ id: string; default_vehicle_id: string | null }>(
      tx,
      `SELECT id, default_vehicle_id FROM instructors
        WHERE status = 'active' AND $1 = ANY(license_categories)
          AND ($2::uuid[] IS NULL OR id = ANY($2::uuid[]))`,
      [student.license_category, q.instructorIds ?? null],
    ),
    () => many<{ id: string }>(
      tx,
      `SELECT id FROM vehicles
        WHERE status = 'active' AND transmission = $1 AND license_category = $2`,
      [student.preferred_transmission, student.license_category],
    ),
    () => q.ignoreStudentPreferences
      ? Promise.resolve([])
      : many<{ weekday: number; start_time: string; end_time: string }>(
          tx,
          `SELECT weekday, start_time::text, end_time::text FROM student_availability WHERE student_id = $1`,
          [q.studentId],
        ),
    () => many<{ start_time: Date; end_time: Date }>(
      tx,
      `SELECT start_time, end_time FROM lessons
        WHERE student_id = $1 AND ${ACTIVE_LESSON} AND NOT (id = ANY($4::uuid[]))
          AND start_time < $3 AND end_time > $2`,
      [q.studentId, from, to, ignore],
    )]);

  const instructorIds = instructors.map((i) => i.id);
  const vehicleIds = vehicles.map((v) => v.id);
  // Pad the window by a day so buffers at the edges are respected.
  const padFrom = DateTime.fromJSDate(from).minus({ days: 1 }).toJSDate();
  const padTo = DateTime.fromJSDate(to).plus({ days: 1 }).toJSDate();

  const [rules, exceptions, instructorLessons, vehicleLessons, vehicleBlocks] = await sequential([
    () => many<{
      instructor_id: string;
      is_recurring: boolean;
      weekday: number | null;
      specific_date: string | null;
      start_time: string;
      end_time: string;
      valid_from: string | null;
      valid_until: string | null;
    }>(
      tx,
      `SELECT instructor_id, is_recurring, weekday, specific_date::text, start_time::text, end_time::text,
              valid_from::text, valid_until::text
         FROM instructor_availability WHERE instructor_id = ANY($1::uuid[])`,
      [instructorIds],
    ),
    () => many<{ instructor_id: string; kind: "available" | "unavailable"; starts_at: Date; ends_at: Date }>(
      tx,
      `SELECT instructor_id, kind, starts_at, ends_at FROM instructor_availability_exceptions
        WHERE instructor_id = ANY($1::uuid[]) AND starts_at < $3 AND ends_at > $2`,
      [instructorIds, padFrom, padTo],
    ),
    () => many<{ instructor_id: string; start_time: Date; end_time: Date }>(
      tx,
      `SELECT instructor_id, start_time, end_time FROM lessons
        WHERE instructor_id = ANY($1::uuid[]) AND ${ACTIVE_LESSON} AND NOT (id = ANY($4::uuid[]))
          AND start_time < $3 AND end_time > $2`,
      [instructorIds, padFrom, padTo, ignore],
    ),
    () => many<{ vehicle_id: string; start_time: Date; end_time: Date }>(
      tx,
      `SELECT vehicle_id, start_time, end_time FROM lessons
        WHERE vehicle_id = ANY($1::uuid[]) AND ${ACTIVE_LESSON} AND NOT (id = ANY($4::uuid[]))
          AND start_time < $3 AND end_time > $2`,
      [vehicleIds, padFrom, padTo, ignore],
    ),
    () => many<{ vehicle_id: string; starts_at: Date; ends_at: Date }>(
      tx,
      `SELECT vehicle_id, starts_at, ends_at FROM vehicle_unavailability
        WHERE vehicle_id = ANY($1::uuid[]) AND starts_at < $3 AND ends_at > $2`,
      [vehicleIds, padFrom, padTo],
    )]);

  return {
    timezone: ctx.timezone,
    from,
    to,
    now,
    durationMinutes: q.durationMinutes ?? s.default_lesson_minutes,
    granularityMinutes: s.slot_granularity_minutes,
    bufferMinutes: s.buffer_minutes,
    minLeadMinutes: q.ignoreLeadTime ? 0 : s.min_booking_lead_hours * 60,
    openingHours: opening.map((o) => ({ weekday: o.weekday, start: o.opens_at, end: o.closes_at })),
    closures: closures.map((c) => ({ startsOn: c.starts_on, endsOn: c.ends_on })),
    instructors: instructors.map((i) => ({
      id: i.id,
      defaultVehicleId: i.default_vehicle_id,
      rules: rules
        .filter((r) => r.instructor_id === i.id)
        .map((r) => ({
          isRecurring: r.is_recurring,
          weekday: r.weekday,
          specificDate: r.specific_date,
          start: r.start_time,
          end: r.end_time,
          validFrom: r.valid_from,
          validUntil: r.valid_until,
        })),
      exceptions: exceptions
        .filter((e) => e.instructor_id === i.id)
        .map((e) => ({ kind: e.kind, start: e.starts_at, end: e.ends_at })),
      busy: ranges(instructorLessons.filter((l) => l.instructor_id === i.id)),
    })),
    vehicles: vehicles.map((v) => ({
      id: v.id,
      busy: ranges(vehicleLessons.filter((l) => l.vehicle_id === v.id)),
      blocked: vehicleBlocks.filter((b) => b.vehicle_id === v.id).map((b) => ({ start: b.starts_at, end: b.ends_at })),
    })),
    requireVehicle: true,
    studentBusy: ranges(studentBusy),
    studentPreferences: studentPrefs.map((p) => ({ weekday: p.weekday, start: p.start_time, end: p.end_time })),
    preferredInstructorId: student.primary_instructor_id,
    distinctTimes: q.distinctTimes,
    maxSlots: q.maxSlots,
  };
}

export async function searchSlots(tx: Tx, ctx: SchoolSchedulingContext, q: SlotQuery): Promise<Slot[]> {
  const input = await buildSlotSearchInput(tx, ctx, q);
  return findAvailableSlots(input);
}

/**
 * Re-validate a slot inside the booking transaction. Returns the slot with a
 * concrete vehicle (keeping the requested one when it is still free).
 */
export async function revalidateSlot(
  tx: Tx,
  ctx: SchoolSchedulingContext,
  q: Omit<SlotQuery, "from" | "to" | "distinctTimes" | "maxSlots">,
  slot: Slot,
): Promise<Slot | null> {
  const input = await buildSlotSearchInput(tx, ctx, {
    ...q,
    from: slot.start,
    to: slot.end,
    durationMinutes: Math.round((slot.end.getTime() - slot.start.getTime()) / 60000),
    instructorIds: [slot.instructorId],
  });
  if (slot.vehicleId && isSlotAvailable(input, slot)) return slot;
  const alt = findAvailableSlots({ ...input, maxSlots: 1 }).find((s) => s.start.getTime() === slot.start.getTime());
  return alt ?? null;
}
