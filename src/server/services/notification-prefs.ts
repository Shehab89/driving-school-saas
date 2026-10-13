/**
 * Who gets which message on which channel.
 *
 * Students choose, per category, e-mail and/or WhatsApp for reminders and
 * lesson updates. Payment and account e-mails (payment requests, receipts,
 * password links) are always sent by e-mail: they are part of the service
 * contract and of account security. WhatsApp needs recorded consent and a
 * Meta-approved template; when WhatsApp was chosen but cannot be used, the
 * message falls back to e-mail rather than silently disappearing.
 */
import { z } from "zod";
import { one, type Tx } from "@/lib/db";
import { ForbiddenError, NotFoundError, PolicyError } from "@/lib/errors";
import { formatDate, formatTimeRange } from "@/lib/time";
import type { Principal } from "../principal";
import { audit } from "./audit";
import type { NotificationType } from "./notifications";

export const STUDENT_CATEGORIES = {
  reminders: ["lesson_reminder"],
  lesson_updates: ["lesson_booked", "lesson_rescheduled", "lesson_cancelled", "reschedule_request_received", "feedback_received"],
} as const satisfies Record<string, readonly NotificationType[]>;
export type StudentCategory = keyof typeof STUDENT_CATEGORIES;

const channelPrefs = z.object({ email: z.boolean().default(true), whatsapp: z.boolean().default(false) }).default({ email: true, whatsapp: false });
const studentPrefsSchema = z.object({ reminders: channelPrefs, lesson_updates: channelPrefs });
export type StudentPrefs = z.output<typeof studentPrefsSchema>;

const userPrefsSchema = z.object({ handoff: z.boolean().default(true) });
export type UserPrefs = z.output<typeof userPrefsSchema>;

export function parseStudentPrefs(raw: unknown): StudentPrefs {
  const r = studentPrefsSchema.safeParse(raw ?? {});
  return r.success ? r.data : studentPrefsSchema.parse({});
}
export function parseUserPrefs(raw: unknown): UserPrefs {
  const r = userPrefsSchema.safeParse(raw ?? {});
  return r.success ? r.data : userPrefsSchema.parse({});
}

export function categoryOf(type: NotificationType): StudentCategory | null {
  for (const [cat, types] of Object.entries(STUDENT_CATEGORIES)) if ((types as readonly string[]).includes(type)) return cat as StudentCategory;
  return null;
}

/** Consent is valid when it was given and not withdrawn afterwards. */
export function hasWhatsAppConsent(optInAt: Date | null, optOutAt: Date | null): boolean {
  return Boolean(optInAt && (!optOutAt || optInAt > optOutAt));
}

export async function updateStudentPrefs(tx: Tx, p: Principal, studentId: string, raw: unknown) {
  if (p.type !== "user" || p.actor.role !== "student" || p.actor.studentId !== studentId) throw new ForbiddenError();
  const prefs = studentPrefsSchema.parse(raw);
  await tx.query(`UPDATE students SET notification_prefs = $2 WHERE id = $1`, [studentId, JSON.stringify(prefs)]);
  await audit(tx, p, "notifications.preferences_changed", "student", studentId, prefs);
  return prefs;
}

export async function updateUserPrefs(tx: Tx, p: Principal, raw: unknown) {
  if (p.type !== "user") throw new ForbiddenError();
  const prefs = userPrefsSchema.parse(raw);
  await tx.query(`UPDATE users SET notification_prefs = $2 WHERE id = $1`, [p.actor.userId, JSON.stringify(prefs)]);
  await audit(tx, p, "notifications.preferences_changed", "user", p.actor.userId, prefs);
  return prefs;
}

/**
 * Record or withdraw WhatsApp consent. Only the student can give consent
 * (in the app, or by sending START, which arrives as a system principal).
 * Anyone acting for the student may withdraw it.
 */
export async function setWhatsAppConsent(tx: Tx, p: Principal, studentId: string, consent: boolean, source: "app" | "keyword") {
  const own = p.type === "user" && p.actor.role === "student" && p.actor.studentId === studentId;
  if (consent && !own && !(p.type === "system" && source === "keyword")) throw new ForbiddenError("Only the student can agree to WhatsApp messages.");
  if (!consent && !own && p.type !== "system") throw new ForbiddenError();
  const s = await one<{ phone_e164: string | null }>(tx, `SELECT phone_e164 FROM students WHERE id = $1 FOR UPDATE`, [studentId]);
  if (!s) throw new NotFoundError("Student");
  if (consent && !s.phone_e164) throw new PolicyError("Add a mobile number first.", "phone_required");
  await tx.query(
    consent ? `UPDATE students SET whatsapp_opt_in_at = now() WHERE id = $1` : `UPDATE students SET whatsapp_opt_out_at = now() WHERE id = $1`,
    [studentId],
  );
  if (s.phone_e164) {
    await tx.query(`UPDATE whatsapp_conversations SET opted_out_at = $2 WHERE wa_phone_e164 = $1`, [s.phone_e164, consent ? null : new Date()]);
  }
  await audit(tx, p, consent ? "whatsapp.consent_given" : "whatsapp.consent_withdrawn", "student", studentId, { source });
}

// ---------------------------------------------------------------------------
// WhatsApp templates
// ---------------------------------------------------------------------------

/**
 * Body parameters ({{1}}, {{2}}, ...) the school's Meta template must use, per
 * notification type. Documented in docs/WHATSAPP.md.
 */
export const WHATSAPP_TEMPLATE_PARAMS: Partial<Record<NotificationType, string[]>> = {
  lesson_reminder: ["first name", "date", "time", "instructor"],
  lesson_booked: ["first name", "date", "time", "instructor"],
  lesson_rescheduled: ["first name", "new date", "new time", "instructor"],
  lesson_cancelled: ["first name", "date", "time"],
  reschedule_request_received: ["first name", "lesson number"],
  feedback_received: ["first name", "lesson number"],
};

interface LessonSnap {
  lesson_number: number;
  start_time: string;
  end_time: string;
  student_first_name: string;
  instructor_name: string;
}

export function whatsappTemplateParams(type: NotificationType, payload: Record<string, unknown>, school: { timezone: string; locale: string }): string[] {
  const l = payload.lesson as LessonSnap | undefined;
  const name = String(l?.student_first_name ?? payload.name ?? "").trim() || "-";
  const date = l ? formatDate(l.start_time, school.timezone, school.locale) : "-";
  const time = l ? formatTimeRange(l.start_time, l.end_time, school.timezone) : "-";
  switch (type) {
    case "lesson_reminder":
    case "lesson_booked":
    case "lesson_rescheduled":
      return [name, date, time, l?.instructor_name ?? "-"];
    case "lesson_cancelled":
      return [name, date, time];
    case "reschedule_request_received":
    case "feedback_received":
      return [name, String(l?.lesson_number ?? "-")];
    default:
      throw new Error(`No WhatsApp template parameters defined for ${type}`);
  }
}
