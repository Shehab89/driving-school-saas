/**
 * The student's reschedule picker: one week as a day x time table.
 *
 * Every cell is a possible start time. It is "free" only when the slot engine
 * (the same query bookLesson re-checks inside the booking transaction) offers
 * it for this student and lesson length, so a green cell is always bookable
 * unless someone takes it first. The exclusion constraints on lessons are the
 * final guard for that race. Grey cells say why they are not offered.
 */
import { DateTime } from "luxon";
import { many, one, sequential, type Tx } from "@/lib/db";
import { NotFoundError } from "@/lib/errors";
import { checkStudentReschedule } from "../policies";
import { dbNow, loadSchoolContext, searchSlots } from "../scheduling/loader";

export type CellState = "free" | "current" | "mine" | "taken" | "closed" | "past";
export type GridCell = { state: CellState; start: string; end: string; slot?: string };

export async function rescheduleGrid(tx: Tx, schoolId: string, studentId: string, lessonId: string, startIso?: string) {
  const lesson = await one<{ id: string; student_id: string; start_time: Date; end_time: Date; status: string; lesson_number: number }>(
    tx,
    `SELECT id, student_id, start_time, end_time, status, lesson_number FROM lessons WHERE id = $1`,
    [lessonId],
  );
  if (!lesson || lesson.student_id !== studentId) throw new NotFoundError("Lesson");
  const ctx = await loadSchoolContext(tx, schoolId);
  const zone = ctx.timezone;
  const s = ctx.settings;
  const now = await dbNow(tx);
  const policy = checkStudentReschedule({ lessonStart: lesson.start_time, status: lesson.status as "scheduled", now, noticeHours: s.min_reschedule_notice_hours, timezone: zone });
  const minutes = Math.round((lesson.end_time.getTime() - lesson.start_time.getTime()) / 60000);

  const today = DateTime.fromJSDate(now, { zone }).startOf("day");
  const horizonEnd = DateTime.fromJSDate(now, { zone }).plus({ days: s.booking_horizon_days });
  const requested = startIso ? DateTime.fromISO(startIso, { zone }).startOf("day") : null;
  // Default to the week of the current lesson (or today if that is in the past).
  let first = requested?.isValid ? requested : DateTime.fromJSDate(lesson.start_time, { zone }).startOf("day");
  if (first < today) first = today;
  const last = first.plus({ days: 7 });

  const [opening, closures, mine] = await sequential([
    () => many<{ weekday: number; opens_at: string; closes_at: string }>(tx, `SELECT weekday, to_char(opens_at,'HH24:MI') AS opens_at, to_char(closes_at,'HH24:MI') AS closes_at FROM school_opening_hours`),
    () => many<{ starts_on: string; ends_on: string }>(tx, `SELECT starts_on::text, ends_on::text FROM school_closures WHERE ends_on >= $1::date AND starts_on <= $2::date`, [first.toISODate(), last.toISODate()]),
    () => many<{ start_time: Date; end_time: Date }>(
      tx,
      `SELECT start_time, end_time FROM lessons WHERE student_id = $1 AND id <> $2 AND status NOT IN ('cancelled','rescheduled') AND start_time < $4 AND end_time > $3`,
      [studentId, lessonId, first.toJSDate(), last.toJSDate()],
    ),
  ]);

  const free = policy.allowed
    ? await searchSlots(tx, ctx, { studentId, durationMinutes: minutes, ignoreLessonIds: [lessonId], distinctTimes: true, from: first.toJSDate(), to: last.toJSDate(), now })
    : [];
  const freeByStart = new Map(free.map((f) => [f.start.getTime(), f]));

  // Rows: from the earliest opening to the latest possible start, every step.
  const step = Math.max(30, s.slot_granularity_minutes);
  const toMin = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));
  const openMin = opening.length ? Math.min(...opening.map((o) => toMin(o.opens_at))) : 8 * 60;
  const closeMin = opening.length ? Math.max(...opening.map((o) => toMin(o.closes_at))) : 18 * 60;
  const times: string[] = [];
  for (let m = Math.ceil(openMin / step) * step; m + minutes <= closeMin; m += step) times.push(`${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`);

  const earliest = now.getTime() + s.min_booking_lead_hours * 3600_000;
  const days = Array.from({ length: 7 }, (_, i) => first.plus({ days: i }));
  const cells: GridCell[][] = times.map((hhmm) =>
    days.map((day) => {
      const start = DateTime.fromISO(`${day.toISODate()}T${hhmm}`, { zone });
      const end = start.plus({ minutes });
      const t = start.toMillis();
      const base = { start: start.toISO()!, end: end.toISO()! };
      if (t === lesson.start_time.getTime()) return { ...base, state: "current" as const };
      const f = freeByStart.get(t);
      if (f) return { ...base, state: "free" as const, slot: [f.start.toISOString(), f.end.toISOString(), f.instructorId, f.vehicleId ?? ""].join("|") };
      if (t < earliest || start > horizonEnd) return { ...base, state: "past" as const };
      const iso = day.toISODate()!;
      const openToday = opening.filter((o) => o.weekday === day.weekday);
      const withinHours = openToday.some((o) => toMin(o.opens_at) <= toMin(hhmm) && toMin(hhmm) + minutes <= toMin(o.closes_at));
      if (!withinHours || closures.some((c) => iso >= c.starts_on && iso <= c.ends_on)) return { ...base, state: "closed" as const };
      if (mine.some((l) => l.start_time.getTime() < end.toMillis() && l.end_time.getTime() > t)) return { ...base, state: "mine" as const };
      return { ...base, state: "taken" as const };
    }),
  );

  const prev = first.minus({ days: 7 });
  return {
    lesson: { id: lesson.id, number: lesson.lesson_number, start: lesson.start_time.toISOString(), end: lesson.end_time.toISOString(), minutes },
    allowed: policy.allowed,
    blockedCode: policy.allowed ? null : policy.code,
    blockedMessage: policy.allowed ? null : policy.message,
    noticeHours: s.min_reschedule_notice_hours,
    requiresApproval: s.reschedule_requires_approval,
    days: days.map((d) => d.toISODate()!),
    times,
    cells,
    freeCount: free.length,
    prevStart: first > today ? (prev < today ? today : prev).toISODate() : null,
    nextStart: last < horizonEnd ? last.toISODate() : null,
  };
}

export type RescheduleGrid = Awaited<ReturnType<typeof rescheduleGrid>>;
