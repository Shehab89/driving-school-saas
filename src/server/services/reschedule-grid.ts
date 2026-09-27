/**
 * Week calendar for the student's Book and Reschedule pop-ups.
 *
 * Rows are time bands (30 min or the school's slot step) across the whole
 * opening day; columns are days. A band is green when it lies inside a free
 * period: the union of every lesson the slot engine (the same query
 * bookLesson re-checks inside the booking transaction) would accept there.
 * Tapping a green band books the lesson that starts there, or the latest
 * lesson that still covers it, so the tail of a period is clickable too.
 * Everything else is grey: taken, closed, too soon, or the student's own
 * lessons. The exclusion constraints on lessons are the final guard when two
 * people pick the same time.
 */
import { DateTime } from "luxon";
import { many, one, sequential, type Tx } from "@/lib/db";
import { NotFoundError } from "@/lib/errors";
import type { Slot } from "../scheduling/engine";
import { checkStudentReschedule } from "../policies";
import { dbNow, loadSchoolContext, searchSlots } from "../scheduling/loader";

export type CellState = "free" | "current" | "mine" | "taken" | "closed" | "past";
export type GridCell = { state: CellState; start: string; end: string; slot?: string; slotStart?: string; slotEnd?: string };

type Mode = { kind: "reschedule"; lessonId: string } | { kind: "book" };

async function weekGrid(tx: Tx, schoolId: string, studentId: string, mode: Mode, startIso?: string) {
  const ctx = await loadSchoolContext(tx, schoolId);
  const zone = ctx.timezone;
  const s = ctx.settings;
  const now = await dbNow(tx);

  let lesson: { id: string; student_id: string; start_time: Date; end_time: Date; status: string; lesson_number: number } | null = null;
  let allowed: boolean;
  let blockedCode: string | null = null;
  let blockedMessage: string | null = null;
  let minutes = s.default_lesson_minutes;
  if (mode.kind === "reschedule") {
    lesson = await one(tx, `SELECT id, student_id, start_time, end_time, status, lesson_number FROM lessons WHERE id = $1`, [mode.lessonId]);
    if (!lesson || lesson.student_id !== studentId) throw new NotFoundError("Lesson");
    const policy = checkStudentReschedule({ lessonStart: lesson.start_time, status: lesson.status as "scheduled", now, noticeHours: s.min_reschedule_notice_hours, timezone: zone });
    allowed = policy.allowed;
    if (!policy.allowed) {
      blockedCode = policy.code;
      blockedMessage = policy.message;
    }
    minutes = Math.round((lesson.end_time.getTime() - lesson.start_time.getTime()) / 60000);
  } else {
    allowed = s.student_self_booking;
    if (!allowed) {
      blockedCode = "self_booking_disabled";
      blockedMessage = "Your school books lessons for you.";
    }
  }

  const today = DateTime.fromJSDate(now, { zone }).startOf("day");
  const horizonEnd = DateTime.fromJSDate(now, { zone }).plus({ days: s.booking_horizon_days });
  const requested = startIso ? DateTime.fromISO(startIso, { zone }).startOf("day") : null;
  // Reschedule opens on the week of the lesson; booking on today.
  let first = requested?.isValid ? requested : lesson ? DateTime.fromJSDate(lesson.start_time, { zone }).startOf("day") : today;
  if (first < today) first = today;
  const last = first.plus({ days: 7 });
  const ignore = lesson ? [lesson.id] : [];

  const [opening, closures, mine] = await sequential([
    () => many<{ weekday: number; opens_at: string; closes_at: string }>(tx, `SELECT weekday, to_char(opens_at,'HH24:MI') AS opens_at, to_char(closes_at,'HH24:MI') AS closes_at FROM school_opening_hours`),
    () => many<{ starts_on: string; ends_on: string }>(tx, `SELECT starts_on::text, ends_on::text FROM school_closures WHERE ends_on >= $1::date AND starts_on <= $2::date`, [first.toISODate(), last.toISODate()]),
    () => many<{ start_time: Date; end_time: Date }>(
      tx,
      `SELECT start_time, end_time FROM lessons WHERE student_id = $1 AND NOT (id = ANY($2::uuid[])) AND status NOT IN ('cancelled','rescheduled') AND start_time < $4 AND end_time > $3`,
      [studentId, ignore, first.toJSDate(), last.toJSDate()],
    ),
  ]);

  const free: Slot[] = allowed
    ? await searchSlots(tx, ctx, { studentId, durationMinutes: minutes, ignoreLessonIds: ignore, distinctTimes: true, from: first.toJSDate(), to: last.toJSDate(), now })
    : [];

  const step = Math.max(30, s.slot_granularity_minutes);
  const toMin = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));
  const hhmm = (m: number) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
  const openMin = opening.length ? Math.min(...opening.map((o) => toMin(o.opens_at))) : 8 * 60;
  const closeMin = opening.length ? Math.max(...opening.map((o) => toMin(o.closes_at))) : 18 * 60;
  const times: string[] = [];
  for (let m = Math.floor(openMin / step) * step; m < closeMin; m += step) times.push(hhmm(m));

  const earliest = now.getTime() + s.min_booking_lead_hours * 3600_000;
  const dur = minutes * 60_000;
  const days = Array.from({ length: 7 }, (_, i) => first.plus({ days: i }));
  const slotValue = (f: Slot) => [f.start.toISOString(), f.end.toISOString(), f.instructorId, f.vehicleId ?? ""].join("|");

  // columns[day][row]
  const columns: GridCell[][] = days.map((day) => {
    const iso = day.toISODate()!;
    const starts = free.filter((f) => DateTime.fromJSDate(f.start, { zone }).toISODate() === iso);
    const openToday = opening.filter((o) => o.weekday === day.weekday);
    const closed = closures.some((c) => iso >= c.starts_on && iso <= c.ends_on);
    return times.map((time) => {
      const start = DateTime.fromISO(`${iso}T${time}`, { zone });
      const t = start.toMillis();
      const end = t + step * 60_000;
      const base = { start: start.toISO()!, end: DateTime.fromMillis(end, { zone }).toISO()! };
      if (lesson && t < lesson.end_time.getTime() && end > lesson.start_time.getTime()) return { ...base, state: "current" as const };
      // Prefer a lesson starting exactly here; otherwise the latest one that still covers this band.
      const own = starts.find((f) => f.start.getTime() === t);
      const cover = own ?? [...starts].reverse().find((f) => f.start.getTime() < t && f.start.getTime() + dur >= end);
      if (cover) return { ...base, state: "free" as const, slot: slotValue(cover), slotStart: cover.start.toISOString(), slotEnd: cover.end.toISOString() };
      if (t < earliest || start > horizonEnd) return { ...base, state: "past" as const };
      const inHours = openToday.some((o) => toMin(o.opens_at) <= toMin(time) && toMin(time) + step <= toMin(o.closes_at));
      if (!inHours || closed) return { ...base, state: "closed" as const };
      if (mine.some((l) => l.start_time.getTime() < end && l.end_time.getTime() > t)) return { ...base, state: "mine" as const };
      return { ...base, state: "taken" as const };
    });
  });

  const prev = first.minus({ days: 7 });
  return {
    mode: mode.kind,
    lesson: lesson ? { id: lesson.id, number: lesson.lesson_number, start: lesson.start_time.toISOString(), end: lesson.end_time.toISOString() } : null,
    minutes,
    step,
    allowed,
    blockedCode,
    blockedMessage,
    noticeHours: s.min_reschedule_notice_hours,
    requiresApproval: mode.kind === "reschedule" && s.reschedule_requires_approval,
    days: days.map((d) => d.toISODate()!),
    times,
    columns,
    /** Row-major view (cells[row][day]) of the same data. */
    cells: times.map((_, r) => columns.map((col) => col[r]!)),
    freeCount: free.length,
    prevStart: first > today ? (prev < today ? today : prev).toISODate() : null,
    nextStart: last < horizonEnd ? last.toISODate() : null,
  };
}

export const rescheduleGrid = (tx: Tx, schoolId: string, studentId: string, lessonId: string, startIso?: string) =>
  weekGrid(tx, schoolId, studentId, { kind: "reschedule", lessonId }, startIso);
export const bookingGrid = (tx: Tx, schoolId: string, studentId: string, startIso?: string) => weekGrid(tx, schoolId, studentId, { kind: "book" }, startIso);

export type RescheduleGrid = Awaited<ReturnType<typeof weekGrid>>;
