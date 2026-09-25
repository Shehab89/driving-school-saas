import { one, withPlatform, withTenant } from "@/lib/db";
import { env } from "@/lib/env";
import { formatDate } from "@/lib/time";
import { applyProviderEvent, type PaymentRow } from "../services/billing";
import { getPaymentProvider } from "./index";

export type PayLinkResult =
  | { kind: "redirect"; url: string }
  | { kind: "already_paid"; schoolName: string }
  | { kind: "not_payable"; status: string }
  | { kind: "not_found" };

/**
 * Resolve the stable /pay/<token> link from an e-mail into a fresh provider
 * checkout. The status shown to the user comes only from our DB, which only
 * webhooks (or staff) can change.
 */
export async function resolvePayLink(token: string): Promise<PayLinkResult> {
  if (!/^[0-9a-f]{48}$/.test(token)) return { kind: "not_found" };
  const found = await withPlatform((tx) => one<{ id: string; school_id: string }>(tx, `SELECT id, school_id FROM payments WHERE pay_token = $1`, [token]));
  if (!found) return { kind: "not_found" };

  return withTenant(found.school_id, async (tx) => {
    const p = await one<PaymentRow & { school_name: string; timezone: string; student_email: string | null; lesson_start: Date | null; connected_account: string | null }>(
      tx,
      `SELECT p.*, s.name AS school_name, s.timezone, st.email AS student_email, l.start_time AS lesson_start, spa.provider_account_id AS connected_account
         FROM payments p
         JOIN schools s ON s.id = p.school_id
         JOIN students st ON st.id = p.student_id
         LEFT JOIN lessons l ON l.id = p.lesson_id
         LEFT JOIN school_payment_accounts spa ON spa.school_id = p.school_id AND spa.provider = p.provider AND spa.status = 'active'
        WHERE p.id = $1 FOR UPDATE OF p`,
      [found.id],
    );
    if (!p) return { kind: "not_found" as const };
    if (p.status === "paid") return { kind: "already_paid" as const, schoolName: p.school_name };
    if (!["pending", "overdue", "failed"].includes(p.status)) return { kind: "not_payable" as const, status: p.status };

    const provider = getPaymentProvider(p.provider);
    const description = p.lesson_start ? `Driving lesson ${formatDate(p.lesson_start, p.timezone)} – ${p.school_name}` : `${p.reference} – ${p.school_name}`;
    const session = await provider.createCheckout({
      paymentId: p.id,
      schoolId: p.school_id,
      amountCents: p.amount_cents,
      currency: p.currency,
      description,
      customerEmail: p.student_email,
      reference: p.reference,
      successUrl: `${env.appUrl}/pay/${token}/done`,
      cancelUrl: `${env.appUrl}/pay/${token}`,
      connectedAccountId: p.connected_account,
      // One session per payment per 10-minute window, so double clicks reuse it.
      idempotencyKey: `checkout:${p.id}:${Math.floor(Date.now() / 600_000)}`,
    });
    await tx.query(`UPDATE payments SET payment_link = $2, provider_checkout_id = $3 WHERE id = $1`, [p.id, session.url, session.providerCheckoutId]);
    return { kind: "redirect" as const, url: session.url };
  });
}

/** Route a verified webhook to its tenant and apply it. */
export async function handlePaymentWebhook(providerName: string, rawBody: string, headers: Headers) {
  const provider = getPaymentProvider(providerName);
  const { schoolId: fromMetadata, event } = await provider.verifyWebhook(rawBody, headers);
  let schoolId = fromMetadata;
  if (!schoolId && event.providerPaymentId) {
    schoolId =
      (await withPlatform((tx) =>
        one<{ school_id: string }>(tx, `SELECT school_id FROM payments WHERE provider = $1 AND provider_payment_id = $2`, [providerName, event.providerPaymentId]),
      ))?.school_id ?? null;
  }
  if (!schoolId) return { applied: false, reason: "unrouted" as const };
  return withTenant(schoolId, (tx) => applyProviderEvent(tx, schoolId!, event));
}
