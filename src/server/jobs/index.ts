/**
 * Background jobs. Run by /api/cron/tick (e.g. Vercel Cron / any scheduler
 * every minute) or `npm run jobs:run`. All jobs are idempotent.
 */
import { DateTime } from "luxon";
import { many, one, withPlatform, withTenant } from "@/lib/db";
import { getEmailProvider } from "../email/provider";
import { renderEmail, type SchoolBrand, type TemplateOverride } from "../email/templates";
import { decryptSecret } from "@/lib/crypto";
import { getWhatsAppSender } from "../whatsapp/client";
import { hasWhatsAppConsent, whatsappTemplateParams } from "../services/notification-prefs";
import type { NotificationType } from "../services/notifications";
import { enqueueNotification } from "../services/notifications";
import { lessonSnapshot } from "../services/lessons";
import { payUrl } from "../services/billing";
import { processPendingConversations } from "../whatsapp/inbound";
import { sweepRateLimits } from "@/lib/rate-limit";
import { log } from "@/lib/log";

const MAX_ATTEMPTS = 5;
const PLATFORM_BRAND: SchoolBrand = { name: "DriveDesk", timezone: "Europe/Amsterdam", currency: "EUR", locale: "en", email: null, phone: null, address: null };
/** Payload keys that must not stay in the database after sending. */
const SECRET_KEYS = ["activation_url", "reset_url", "code"];

interface NotificationRow {
  id: string;
  school_id: string | null;
  channel: "email" | "whatsapp" | "sms";
  to_address: string;
  type: NotificationType;
  payload: Record<string, unknown>;
  attempts: number;
  recipient_student_id: string | null;
}

type Outcome = { kind: "sent"; provider: string; messageId: string } | { kind: "suppressed"; reason: string };

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
        RETURNING id, school_id, channel, to_address, type, payload, attempts, recipient_student_id`,
      [limit],
    );
  });

  let sent = 0;
  for (const n of batch) {
    try {
      const outcome = n.channel === "email" ? await sendEmail(n) : n.channel === "whatsapp" ? await sendWhatsApp(n) : null;
      if (!outcome) throw new Error(`channel ${n.channel} not supported for notifications`);
      if (outcome.kind === "suppressed") {
        await withPlatform((tx) =>
          tx.query(`UPDATE notifications SET status = 'suppressed', last_error = $2, payload = payload - $3::text[] WHERE id = $1`, [n.id, outcome.reason, SECRET_KEYS]),
        );
        continue;
      }
      await withPlatform((tx) =>
        tx.query(
          `UPDATE notifications SET status = 'sent', sent_at = now(), provider = $2, provider_message_id = $3, last_error = NULL,
                  payload = payload - $4::text[]
            WHERE id = $1`,
          [n.id, outcome.provider, outcome.messageId, SECRET_KEYS],
        ),
      );
      sent++;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const final = n.attempts >= MAX_ATTEMPTS;
      log.warn(final ? "notification.failed_permanently" : "notification.retry_scheduled", { id: n.id, type: n.type, attempt: n.attempts, err: msg });
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

async function schoolBrand(schoolId: string | null) {
  // Platform-level accounts (no school) get platform branding.
  if (!schoolId) return PLATFORM_BRAND;
  const school = await withPlatform((tx) =>
    one<SchoolBrand>(tx, `SELECT name, timezone, currency, locale, email, phone, address FROM schools WHERE id = $1`, [schoolId]),
  );
  if (!school) throw new Error("school missing");
  return school;
}

async function sendEmail(n: NotificationRow): Promise<Outcome> {
  const suppressed = await withPlatform((tx) => one<{ reason: string }>(tx, `SELECT reason FROM email_suppressions WHERE email = $1`, [n.to_address]));
  if (suppressed) return { kind: "suppressed", reason: `address ${suppressed.reason} earlier` };
  const school = await schoolBrand(n.school_id);
  const override = n.school_id
    ? await withTenant(n.school_id, (tx) =>
        one<TemplateOverride>(tx, `SELECT subject, intro FROM notification_template_overrides WHERE type = $1`, [n.type]),
      )
    : null;
  const rendered = renderEmail(n.type, n.payload, school, override);
  const provider = getEmailProvider();
  const res = await provider.send({
    to: n.to_address,
    subject: rendered.subject,
    html: rendered.html,
    text: rendered.text,
    fromName: school.name,
    replyTo: school.email ?? undefined,
    idempotencyKey: `notification-${n.id}`,
    tags: { type: n.type },
  });
  return { kind: "sent", provider: provider.name, messageId: res.id };
}

/** Proactive WhatsApp message via the school's approved template, re-checking consent at send time. */
async function sendWhatsApp(n: NotificationRow): Promise<Outcome> {
  if (!n.school_id) throw new Error("WhatsApp notifications need a school");
  const school = await schoolBrand(n.school_id);
  const ctx = await withTenant(n.school_id, async (tx) => ({
    account: await one<{ phone_number_id: string; access_token_encrypted: string; templates: Record<string, { name: string; language: string }> }>(
      tx,
      `SELECT phone_number_id, access_token_encrypted, templates FROM whatsapp_accounts WHERE status = 'active'`,
    ),
    student: n.recipient_student_id
      ? await one<{ whatsapp_opt_in_at: Date | null; whatsapp_opt_out_at: Date | null }>(
          tx,
          `SELECT whatsapp_opt_in_at, whatsapp_opt_out_at FROM students WHERE id = $1`,
          [n.recipient_student_id],
        )
      : null,
    conversationOptOut: await one(tx, `SELECT 1 FROM whatsapp_conversations WHERE wa_phone_e164 = $1 AND opted_out_at IS NOT NULL`, [n.to_address]),
  }));
  if (!ctx.student || !hasWhatsAppConsent(ctx.student.whatsapp_opt_in_at, ctx.student.whatsapp_opt_out_at) || ctx.conversationOptOut) {
    return { kind: "suppressed", reason: "no WhatsApp consent" };
  }
  const template = ctx.account?.templates?.[n.type];
  if (!ctx.account || !template) return { kind: "suppressed", reason: "no active WhatsApp account or template" };
  const res = await getWhatsAppSender().sendTemplate({
    phoneNumberId: ctx.account.phone_number_id,
    accessToken: decryptSecret(ctx.account.access_token_encrypted),
    to: n.to_address,
    name: template.name,
    language: template.language,
    params: whatsappTemplateParams(n.type, n.payload, school),
  });
  return { kind: "sent", provider: "whatsapp", messageId: res.waMessageId };
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
          AND l.reminder_handled_at IS NULL
          AND l.start_time > now()
          AND l.start_time <= now() + make_interval(hours => ss.reminder_hours_before)
        LIMIT 500`,
    ),
  );
  for (const l of due) {
    await withTenant(l.school_id, async (tx) => {
      // Channels (e-mail / WhatsApp / none) follow the student's preferences.
      await enqueueNotification(tx, {
        schoolId: l.school_id,
        type: "lesson_reminder",
        to: l.email,
        studentId: l.student_id,
        lessonId: l.id,
        payload: { lesson: await lessonSnapshot(tx, l.id) },
        dedupeKey: `reminder:${l.id}`,
      });
      await tx.query(`UPDATE lessons SET reminder_handled_at = now() WHERE id = $1`, [l.id]);
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

/**
 * Run every job, each isolated: one failing job (e.g. a provider outage) is
 * logged and reported but never stops the others. Failed work stays queued in
 * the database and is retried on the next tick.
 */
export async function runAllJobs() {
  const jobs: Record<string, () => Promise<unknown>> = {
    reminders: scheduleLessonReminders,
    overdue: markOverduePayments,
    whatsapp: processPendingConversations,
    notifications: () => deliverNotifications(),
    rateLimits: sweepRateLimits,
  };
  const results: Record<string, unknown> = {};
  let failed = 0;
  for (const [name, job] of Object.entries(jobs)) {
    const started = Date.now();
    try {
      results[name] = await job();
    } catch (err) {
      failed++;
      results[name] = { error: err instanceof Error ? err.message : String(err) };
      log.error("job.failed", { job: name, err });
    }
    log.debug("job.done", { job: name, ms: Date.now() - started });
  }
  return { ok: failed === 0, ...results };
}
