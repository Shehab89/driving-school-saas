import "server-only";
/**
 * Turns the week grid into what the calendar pop-up draws: per day, runs of
 * equal state (a green free period, a grey busy block, the current lesson).
 * Used to render the pop-up on the server (so it shows instantly) and by the
 * week-navigation server action.
 */
import { cache } from "react";
import { DateTime } from "luxon";
import { withTenant } from "@/lib/db";
import { tryTranslate } from "@/i18n";
import type { SchoolActor } from "@/lib/rbac";
import { schoolI18n } from "@/server/school";
import { bookingGrid, rescheduleGrid, type CellState } from "@/server/services/reschedule-grid";

export type CalFreeCell = { row: number; slot: string; label: string; time: string; slotRow: number; slotRows: number; meet: string | null; ends: string | null; moved: boolean };
export type CalRun = { state: CellState; from: number; rows: number; label: string | null; cells?: CalFreeCell[] };
export type CalData = {
  mode: "book" | "reschedule";
  lessonId: string | null;
  title: string;
  current: string | null;
  allowed: boolean;
  blocked: string | null;
  requiresApproval: boolean;
  minutes: number;
  range: string;
  days: { iso: string; dow: string; date: string; long: string; today: boolean; free: number }[];
  times: string[];
  columns: CalRun[][];
  freeCount: number;
  prevStart: string | null;
  nextStart: string | null;
  /** Month picker: first and last day that can be chosen, and the locale for month and weekday names. */
  today: string;
  lastDay: string;
  locale: string;
};

/** Pages can show the same calendar behind two buttons; compute each distinct one once per request. */
const weekFor = cache((schoolId: string, studentId: string, lessonId: string | null, startIso: string | undefined) =>
  withTenant(schoolId, (tx) => (lessonId ? rescheduleGrid(tx, schoolId, studentId, lessonId, startIso) : bookingGrid(tx, schoolId, studentId, startIso))),
);

export async function loadCalendarData(actor: SchoolActor, lessonId: string | null, startIso?: string): Promise<CalData> {
  const { t, f, locale, school } = await schoolI18n(actor.schoolId);
  const zone = school.timezone;
  const g = await weekFor(actor.schoolId, actor.studentId!, lessonId, startIso);
  const today = DateTime.now().setZone(zone).toISODate();
  const time = (iso: string) => DateTime.fromISO(iso, { zone }).toFormat("HH:mm");
  const rowOf = (iso: string) => {
    const m = DateTime.fromISO(iso, { zone });
    const first = g.times[0]!;
    return ((m.hour * 60 + m.minute) - (Number(first.slice(0, 2)) * 60 + Number(first.slice(3, 5)))) / g.step;
  };

  const columns: CalRun[][] = g.columns.map((col) => {
    const runs: CalRun[] = [];
    col.forEach((c, row) => {
      const lastRun = runs[runs.length - 1];
      if (lastRun && lastRun.state === c.state) lastRun.rows++;
      else runs.push({ state: c.state, from: row, rows: 1, label: null, cells: c.state === "free" ? [] : undefined });
      const run = runs[runs.length - 1]!;
      if (c.state === "free") {
        const pl = c.places;
        const meet = pl?.pickup ? (pl.pickupMoved ? t("student.places.meetPrevious", { place: pl.pickup }) : pl.pickup) : null;
        const ends = pl?.dropoff ? (pl.dropoffMoved ? t("student.places.endNext", { place: pl.dropoff }) : pl.dropoff) : null;
        run.cells!.push({ row, slot: c.slot!, label: `${f.shortDate(c.slotStart!)} ${f.range(c.slotStart!, c.slotEnd!)}`, time: time(c.slotStart!), slotRow: rowOf(c.slotStart!), slotRows: g.minutes / g.step, meet, ends, moved: !!(pl?.pickupMoved || pl?.dropoffMoved) });
      }
    });
    for (const r of runs) {
      const startIso = col[r.from]!.start;
      const endIso = col[r.from + r.rows - 1]!.end;
      const span = `⁦${time(startIso)}–${time(endIso)}⁩`;
      if (r.state === "free") r.label = span;
      else if (r.state === "current") r.label = t("student.picker.current");
      else if (r.state === "mine") r.label = t("student.picker.yours");
      else if (r.state === "taken" && r.rows >= 2) r.label = t("student.picker.taken");
    }
    return runs;
  });

  return {
    mode: lessonId ? "reschedule" : "book",
    lessonId,
    title: g.lesson ? t("student.picker.title", { number: g.lesson.number }) : t("student.bookTitle"),
    current: g.lesson ? `${f.date(g.lesson.start)} · ${f.range(g.lesson.start, g.lesson.end)}` : null,
    allowed: g.allowed,
    blocked: g.allowed ? null : (tryTranslate(locale, `errors.${g.blockedCode}`, { hours: g.noticeHours }) ?? g.blockedMessage),
    requiresApproval: g.requiresApproval,
    minutes: g.minutes,
    range: `${f.dayMonth(g.days[0]!)} – ${f.dayMonth(g.days[6]!)}`,
    days: g.days.map((iso, i) => {
      const d = DateTime.fromISO(iso, { zone });
      const free = new Set(g.columns[i]!.filter((c) => c.state === "free").map((c) => c.slot)).size;
      return { iso, dow: f.weekdayShort(d.weekday), date: d.toFormat("d/M"), long: f.date(d.toJSDate()), today: iso === today, free };
    }),
    times: g.times,
    columns,
    freeCount: g.freeCount,
    prevStart: g.prevStart,
    nextStart: g.nextStart,
    today: g.today,
    lastDay: g.lastDay,
    locale,
  };
}
