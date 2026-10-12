import { NextResponse } from "next/server";
import { one, withPlatform } from "@/lib/db";
import { hasCronSecret } from "@/lib/cron-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Operational health for monitoring (uptime checker, on-call). Needs the cron
 * secret because it reveals queue sizes. Returns 503 when something needs a
 * person: the database is unreachable, e-mails are stuck, or jobs stopped.
 */
export async function GET(req: Request) {
  if (!hasCronSecret(req)) return new Response("unauthorized", { status: 401 });
  const started = Date.now();
  try {
    const q = await withPlatform((tx) =>
      one<{ stuck_notifications: number; failed_notifications_24h: number; pending_whatsapp: number; unprocessed_payment_events: number; last_sent: string | null }>(
        tx,
        `SELECT
           (SELECT count(*)::int FROM notifications WHERE status IN ('queued','sending') AND scheduled_for < now() - interval '15 minutes') AS stuck_notifications,
           (SELECT count(*)::int FROM notifications WHERE status = 'failed' AND created_at > now() - interval '24 hours') AS failed_notifications_24h,
           (SELECT count(*)::int FROM whatsapp_messages WHERE processing_status IN ('pending','processing') AND created_at < now() - interval '10 minutes') AS pending_whatsapp,
           (SELECT count(*)::int FROM payment_provider_events WHERE processed_at IS NULL AND received_at < now() - interval '10 minutes') AS unprocessed_payment_events,
           (SELECT max(sent_at)::text FROM notifications) AS last_sent`,
      ),
    );
    const dbMs = Date.now() - started;
    const checks = {
      database: { ok: true, ms: dbMs },
      notifications: { ok: q!.stuck_notifications === 0, stuck: q!.stuck_notifications, failed24h: q!.failed_notifications_24h, lastSent: q!.last_sent },
      whatsapp: { ok: q!.pending_whatsapp === 0, pending: q!.pending_whatsapp },
      payments: { ok: q!.unprocessed_payment_events === 0, unprocessedEvents: q!.unprocessed_payment_events },
      config: {
        email: process.env.EMAIL_PROVIDER === "resend" && Boolean(process.env.RESEND_API_KEY),
        stripe: Boolean(process.env.STRIPE_SECRET_KEY && process.env.STRIPE_WEBHOOK_SECRET),
        whatsapp: Boolean(process.env.META_APP_SECRET && process.env.WHATSAPP_VERIFY_TOKEN),
        ai: Boolean(process.env.ANTHROPIC_API_KEY),
      },
    };
    const ok = checks.notifications.ok && checks.whatsapp.ok && checks.payments.ok;
    return NextResponse.json({ ok, checks }, { status: ok ? 200 : 503 });
  } catch {
    return NextResponse.json({ ok: false, checks: { database: { ok: false } } }, { status: 503 });
  }
}
