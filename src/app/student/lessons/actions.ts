"use server";
/** Server actions behind the reschedule pop-up. Both run with the signed-in student's tenant (RLS) scope. */
import { revalidatePath } from "next/cache";
import { DateTime } from "luxon";
import { withTenant } from "@/lib/db";
import { AppError } from "@/lib/errors";
import { tryTranslate } from "@/i18n";
import { requireSchoolActor } from "@/server/auth/session";
import { userPrincipal } from "@/server/principal";
import { schoolI18n } from "@/server/school";
import { rescheduleLesson } from "@/server/services/lessons";
import { rescheduleGrid, type CellState } from "@/server/services/reschedule-grid";

export type PickerCell = { state: CellState; label: string; slot?: string };
export type PickerData = {
  lessonNumber: number;
  current: string;
  allowed: boolean;
  blocked: string | null;
  requiresApproval: boolean;
  days: { iso: string; dow: string; date: string; today: boolean }[];
  times: string[];
  cells: PickerCell[][];
  freeCount: number;
  prevStart: string | null;
  nextStart: string | null;
  range: string;
};

function errorMessage(locale: Parameters<typeof tryTranslate>[0], err: unknown) {
  if (err instanceof AppError) {
    const params = Object.fromEntries(Object.entries(err.details ?? {}).filter(([, v]) => typeof v === "string" || typeof v === "number")) as Record<string, string | number>;
    return { code: err.code, message: tryTranslate(locale, `errors.${err.code}`, params) ?? err.message };
  }
  console.error("[reschedule]", err);
  return { code: "generic", message: tryTranslate(locale, "errors.generic")! };
}

export async function loadRescheduleGrid(lessonId: string, startIso?: string): Promise<{ ok: true; data: PickerData } | { ok: false; message: string }> {
  const actor = await requireSchoolActor("lessons:request_reschedule");
  const { f, locale, school } = await schoolI18n(actor.schoolId);
  try {
    const g = await withTenant(actor.schoolId, (tx) => rescheduleGrid(tx, actor.schoolId, actor.studentId!, lessonId, startIso));
    const today = DateTime.now().setZone(school.timezone).toISODate();
    return {
      ok: true,
      data: {
        lessonNumber: g.lesson.number,
        current: `${f.date(g.lesson.start)} · ${f.range(g.lesson.start, g.lesson.end)}`,
        allowed: g.allowed,
        blocked: g.allowed ? null : (tryTranslate(locale, `errors.${g.blockedCode}`, { hours: g.noticeHours }) ?? g.blockedMessage),
        requiresApproval: g.requiresApproval,
        days: g.days.map((iso) => {
          const d = DateTime.fromISO(iso, { zone: school.timezone });
          return { iso, dow: f.weekdayShort(d.weekday), date: f.luxon(d.toJSDate()).toFormat("d/M"), today: iso === today };
        }),
        times: g.times,
        cells: g.cells.map((row) => row.map((c) => ({ state: c.state, slot: c.slot, label: `${f.shortDate(c.start)} ${f.range(c.start, c.end)}` }))),
        freeCount: g.freeCount,
        prevStart: g.prevStart,
        nextStart: g.nextStart,
        range: `${f.dayMonth(g.days[0]!)} – ${f.dayMonth(g.days[6]!)}`,
      },
    };
  } catch (err) {
    return { ok: false, message: errorMessage(locale, err).message };
  }
}

export async function moveLesson(lessonId: string, slot: string, reason: string): Promise<{ ok: true; pending: boolean; message: string } | { ok: false; code: string; message: string }> {
  const actor = await requireSchoolActor("lessons:request_reschedule");
  const { t, locale } = await schoolI18n(actor.schoolId);
  const [start, end, instructorId, vehicleId] = slot.split("|");
  if (!start || !end || !instructorId) return { ok: false, code: "pickTime", message: t("errors.pickTime") };
  try {
    const r = await withTenant(actor.schoolId, (tx) =>
      rescheduleLesson(
        tx,
        userPrincipal(actor),
        lessonId,
        { start: new Date(start), end: new Date(end), instructorId, vehicleId: vehicleId || null },
        { channel: "student_portal", reason: reason.trim().slice(0, 300) || undefined },
      ),
    );
    revalidatePath("/student", "layout");
    const pending = r.status === "pending_approval";
    return { ok: true, pending, message: pending ? t("student.rescheduleRequestedOk") : t("student.rescheduledOk") };
  } catch (err) {
    return { ok: false, ...errorMessage(locale, err) };
  }
}
