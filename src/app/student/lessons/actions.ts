"use server";
/** Server actions behind the Book / Reschedule calendar pop-up. All run in the signed-in student's tenant (RLS) scope. */
import { revalidatePath } from "next/cache";
import { after } from "next/server";
import { withTenant } from "@/lib/db";
import { AppError } from "@/lib/errors";
import { tryTranslate } from "@/i18n";
import { requireSchoolActor } from "@/server/auth/session";
import { deliverNotifications } from "@/server/jobs";
import { userPrincipal } from "@/server/principal";
import { schoolI18n } from "@/server/school";
import { loadCalendarData, type CalData } from "@/server/slot-calendar";
import { bookLesson, rescheduleLesson } from "@/server/services/lessons";

type Result = { ok: true; pending: boolean; message: string } | { ok: false; code: string; message: string };

function errorMessage(locale: Parameters<typeof tryTranslate>[0], err: unknown) {
  if (err instanceof AppError) {
    const params = Object.fromEntries(Object.entries(err.details ?? {}).filter(([, v]) => typeof v === "string" || typeof v === "number")) as Record<string, string | number>;
    return { code: err.code, message: tryTranslate(locale, `errors.${err.code}`, params) ?? err.message };
  }
  console.error("[calendar]", err);
  return { code: "generic", message: tryTranslate(locale, "errors.generic")! };
}

function parseSlot(slot: string) {
  const [start, end, instructorId, vehicleId] = slot.split("|");
  if (!start || !end || !instructorId) return null;
  return { start: new Date(start), end: new Date(end), instructorId, vehicleId: vehicleId || null };
}

/** One week of the calendar (lessonId = null for booking a new lesson). */
export async function loadCalendar(lessonId: string | null, startIso?: string): Promise<{ ok: true; data: CalData } | { ok: false; message: string }> {
  const actor = await requireSchoolActor("lessons:request_reschedule");
  try {
    return { ok: true, data: await loadCalendarData(actor, lessonId, startIso) };
  } catch (err) {
    const { locale } = await schoolI18n(actor.schoolId);
    return { ok: false, message: errorMessage(locale, err).message };
  }
}

export async function moveLesson(lessonId: string, slot: string, reason: string): Promise<Result> {
  const actor = await requireSchoolActor("lessons:request_reschedule");
  const { t, locale } = await schoolI18n(actor.schoolId);
  const s = parseSlot(slot);
  if (!s) return { ok: false, code: "pickTime", message: t("errors.pickTime") };
  try {
    const r = await withTenant(actor.schoolId, (tx) =>
      rescheduleLesson(tx, userPrincipal(actor), lessonId, s, { channel: "student_portal", reason: reason.trim().slice(0, 300) || undefined }),
    );
    after(() => deliverNotifications(10).catch(() => undefined));
    revalidatePath("/student", "layout");
    const pending = r.status === "pending_approval";
    return { ok: true, pending, message: pending ? t("student.rescheduleRequestedOk") : t("student.rescheduledOk") };
  } catch (err) {
    return { ok: false, ...errorMessage(locale, err) };
  }
}

export async function bookSlot(slot: string): Promise<Result> {
  const actor = await requireSchoolActor("lessons:request_reschedule");
  const { t, locale } = await schoolI18n(actor.schoolId);
  const s = parseSlot(slot);
  if (!s) return { ok: false, code: "pickTime", message: t("errors.pickTime") };
  try {
    // bookLesson re-checks availability, lead time and the school's self-booking setting in the transaction.
    await withTenant(actor.schoolId, (tx) => bookLesson(tx, userPrincipal(actor), { studentId: actor.studentId!, slot: s, bookedVia: "student_portal" }));
    after(() => deliverNotifications(10).catch(() => undefined));
    revalidatePath("/student", "layout");
    return { ok: true, pending: false, message: t("student.bookedOk") };
  } catch (err) {
    return { ok: false, ...errorMessage(locale, err) };
  }
}
