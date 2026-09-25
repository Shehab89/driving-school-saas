/**
 * Background jobs. Run by /api/cron/tick (e.g. Vercel Cron / any scheduler
 * every minute) or `npm run jobs:run`. All jobs are idempotent.
 */
import { DateTime } from "luxon";
import { many, one, withPlatform, withTenant } from "@/lib/db";
import { getEmailProvider } from "../email/provider";
import { renderEmail, type SchoolBrand } from "../email/templates";
import type { NotificationType } from "../services/notifications";
import { enqueueNotification } from "../services/notifications";
import { lessonSnapshot } from "../services/lessons";
import { payUrl } from "../services/billing";
import { processPendingConversations } from "../whatsapp/inbound";

const MAX_ATTEMPTS = 5;
/** Payload keys that must not stay in the database after sending. */
const SECRET_KEYS = ["activation_url", "code"];

interface NotificationRow {
  id: string;
  school_id: string;
  channel: "email" | "whatsapp" | "sms";
  to_address: string;
  type: NotificationType;
  payload: Record<string, unknown>;
  attempts: number;
}

/** Deliver queued notifications (transactional outbox consumer). */
export async function deliverNotifications(limit = 50) {
  // Claim a batch across tenants (system job => platform role), SKIP LOCKED so several workers can run.
  const batch = await withPlatform(async (tx) => {
    await tx.query(`UPDATE notifications SET status = 'queued' WHERE status = 'sending' AND scheduled_for < now() - interval '10 minutes'`);
    return many<NotificationRow>(
      tx,
      `UPDATE notifications SET status = 'sending', attempts = attempts + 1
        WHERE id IN (SELECT id FROM notifications WHERE status = 'queued' AND scheduled_for <= now()
                      ORDER BY scheduled_for LIMIT $1 FOR UPDATE SKIP LOCKED)
        RETURNING id, school_id, channel, to_address, type, payload, attempts`,
      [limit],
    );
  });

  let sent = 0;
  for (const n of batch) {
    try {
      const school = await withPlatform((tx) =>
        one<SchoolBrand>(tx, `SELECT name, timezone, currency, locale, email, phone, address FROM schools WHERE id = $1`, [n.school_id]),
      );
      if (!school) throw new Error("school missing");
      if (n.channel !== "email") throw new Error(`channel ${n.channel} not supported for notifications`);
      const rendered = renderEmail(n.type, n.payload, school);
      const res = await getEmailProvider().send({
        to: n.to_address,
        subject: rendered.subject,
        html: rendered.html,
        text: rendered.text,
        fromName: school.name,
        replyTo: school.email ?? undefined,
        idempotencyKey: `notification-${n.id}`,
        tags: { type: n.type },
      });
      await withPlatform((tx) =>
        tx.query(
          `UPDATE notifications SET status = 'sent', sent_at = now(), provider = $2, provider_message_id = $3, last_error = NULL,
                  payload = payload - $4::text[]
            WHERE id = $1`,
          [n.id, getEmailProvider().name, res.id, SECRET_KEYS],
        ),
      );
      sent++;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const final = n.attempts >= MAX_ATTEMPTS;
      await withPlatform((tx) =>
        tx.query(
          `UPDATE notifications SET status = $2, last_error = $3, scheduled_for = now() + make_interval(mins => $4) WHERE id = $1`,
          [n.id, final ? "failed" : "queued", msg.slice(0, 1000), 2 ** n.attempts],
        ),
      );
    }
  }
  return { claimed: batch.length, sent };
}

/** Queue "lesson tomorrow" reminders according to each school's reminder_hours_before. */
export async function scheduleLessonReminders() {
  const due = await withPlatform((tx) =>
    many<{ id: string; school_id: string; student_id: string; email: string | null }>(
      tx,
      `SELECT l.id, l.school_id, l.student_id, s.email
         FROM lessons l
         JOIN school_settings ss ON ss.school_id = l.school_id
         JOIN students s ON s.id = l.student_id
        WHERE l.status IN ('scheduled','confirmed')
          AND l.start_time > now()
          AND l.start_time <= now() + make_interval(hours => ss.reminder_hours_before)
          AND s.email IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM notifications n WHERE n.school_id = l.school_id AND n.dedupe_key = 'reminder:' || l.id)
        LIMIT 500`,
    ),
  );
  for (const l of due) {
    await withTenant(l.school_id, async (tx) => {
      await enqueueNotification(tx, {
        schoolId: l.school_id,
        type: "lesson_reminder",
        to: l.email,
        studentId: l.student_id,
        lessonId: l.id,
        payload: { lesson: await lessonSnapshot(tx, l.id) },
        dedupeKey: `reminder:${l.id}`,
      });
    });
  }
  return due.length;
}

/** Mark pending payments overdue once their due date has passed in the school's timezone, and remind once. */
export async function markOverduePayments() {
  const schools = await withPlatform((tx) => many<{ id: string; timezone: string }>(tx, `SELECT id, timezone FROM schools WHERE status IN ('trial','active')`));
  let count = 0;
  for (const s of schools) {
    const today = DateTime.now().setZone(s.timezone).toISODate()!;
    count += await withTenant(s.id, async (tx) => {
      const rows = await many<{ id: string; student_id: string; lesson_id: string | null; amount_cents: number; currency: string; due_date: string; pay_token: string; email: string | null; first_name: string }>(
        tx,
        `UPDATE payments p SET status = 'overdue'
           FROM students st
          WHERE p.student_id = st.id AND p.status = 'pending' AND p.due_date < $1::date
          RETURNING p.id, p.student_id, p.lesson_id, p.amount_cents, p.currency, p.due_date, p.pay_token, st.email, st.first_name`,
        [today],
      );
      for (const r of rows) {
        await tx.query(`UPDATE invoices SET status = 'overdue' WHERE id = (SELECT invoice_id FROM payments WHERE id = $1) AND status = 'open'`, [r.id]);
        if (r.lesson_id) await tx.query(`UPDATE lessons SET payment_status = 'overdue' WHERE id = $1 AND payment_status = 'pending'`, [r.lesson_id]);
        await enqueueNotification(tx, {
          schoolId: s.id,
          type: "payment_overdue",
          to: r.email,
          studentId: r.student_id,
          paymentId: r.id,
          payload: { name: r.first_name, amount_cents: r.amount_cents, currency: r.currency, due_date: r.due_date, pay_url: payUrl(r.pay_token) },
          dedupeKey: `overdue:${r.id}`,
        });
      }
      return rows.length;
    });
  }
  return count;
}

export async function runAllJobs() {
  const reminders = await scheduleLessonReminders();
  const overdue = await markOverduePayments();
  const whatsapp = await processPendingConversations().catch(() => 0);
  const notifications = await deliverNotifications();
  return { reminders, overdue, whatsapp, notifications };
}
