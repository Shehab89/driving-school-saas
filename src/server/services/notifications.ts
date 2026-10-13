import { one, type Tx } from "@/lib/db";
import { categoryOf, hasWhatsAppConsent, parseStudentPrefs, parseUserPrefs } from "./notification-prefs";

export type NotificationType =
  | "student_welcome"
  | "user_invite"
  | "lesson_booked"
  | "lesson_reminder"
  | "lesson_rescheduled"
  | "lesson_cancelled"
  | "lesson_completed_payment_request"
  | "payment_succeeded"
  | "payment_overdue"
  | "reschedule_request_received"
  | "handoff_requested"
  | "whatsapp_link_code"
  | "feedback_received"
  | "password_reset"
  | "password_changed"
  | "booking_payment_request"
  | "package_payment_request"
  | "payment_failed"
  | "payment_refunded"
  | "payment_disputed";

export interface EnqueueArgs {
  /** NULL only for platform-level accounts (SaaS admins). */
  schoolId: string | null;
  type: NotificationType;
  channel?: "email" | "whatsapp";
  to: string | null | undefined;
  studentId?: string | null;
  userId?: string | null;
  lessonId?: string | null;
  paymentId?: string | null;
  payload?: Record<string, unknown>;
  dedupeKey?: string;
  scheduledFor?: Date;
}

/**
 * Transactional outbox: the notification row is written in the same
 * transaction as the business change, and a worker delivers it afterwards
 * (src/server/jobs/notification-worker.ts). If the transaction rolls back,
 * no e-mail is sent; if the provider is down, the worker retries.
 */
export async function enqueueNotification(tx: Tx, a: EnqueueArgs): Promise<string | null> {
  // Student messages that the student can configure: pick channels from their preferences.
  const category = a.studentId && !a.channel && a.schoolId ? categoryOf(a.type) : null;
  if (category) {
    const s = await one<{ phone_e164: string | null; notification_prefs: unknown; whatsapp_opt_in_at: Date | null; whatsapp_opt_out_at: Date | null; has_template: boolean | null }>(
      tx,
      `SELECT st.phone_e164, st.notification_prefs, st.whatsapp_opt_in_at, st.whatsapp_opt_out_at,
              (SELECT wa.templates ? $2 FROM whatsapp_accounts wa WHERE wa.status = 'active') AS has_template
         FROM students st WHERE st.id = $1`,
      [a.studentId, a.type],
    );
    if (s) {
      const pref = parseStudentPrefs(s.notification_prefs)[category];
      const whatsapp = pref.whatsapp && Boolean(s.phone_e164) && Boolean(s.has_template) && hasWhatsAppConsent(s.whatsapp_opt_in_at, s.whatsapp_opt_out_at);
      // WhatsApp chosen but not possible (no consent / number / template): fall back to e-mail.
      const email = pref.email || (pref.whatsapp && !whatsapp);
      const ids = [
        email ? await insertNotification(tx, a, "email", a.to, a.dedupeKey) : null,
        whatsapp ? await insertNotification(tx, a, "whatsapp", s.phone_e164, a.dedupeKey && `${a.dedupeKey}:wa`) : null,
      ];
      return ids.find(Boolean) ?? null;
    }
  }
  // Staff can switch off "a WhatsApp chat needs you" e-mails.
  if (a.type === "handoff_requested" && a.userId) {
    const u = await one<{ notification_prefs: unknown }>(tx, `SELECT notification_prefs FROM users WHERE id = $1`, [a.userId]);
    if (u && !parseUserPrefs(u.notification_prefs).handoff) return null;
  }
  return insertNotification(tx, a, a.channel ?? "email", a.to, a.dedupeKey);
}

async function insertNotification(tx: Tx, a: EnqueueArgs, channel: "email" | "whatsapp", to: string | null | undefined, dedupeKey: string | undefined) {
  if (!to) return null; // recipient has no address on file
  const r = await tx.query<{ id: string }>(
    `INSERT INTO notifications (school_id, type, channel, to_address, recipient_student_id, recipient_user_id,
                                lesson_id, payment_id, payload, dedupe_key, scheduled_for)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,COALESCE($11, now()))
     ON CONFLICT (school_id, dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING
     RETURNING id`,
    [
      a.schoolId,
      a.type,
      channel,
      to,
      a.studentId ?? null,
      a.userId ?? null,
      a.lessonId ?? null,
      a.paymentId ?? null,
      JSON.stringify(a.payload ?? {}),
      dedupeKey ?? null,
      a.scheduledFor ?? null,
    ],
  );
  return r.rows[0]?.id ?? null;
}
