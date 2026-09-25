import Stripe from "stripe";
import { env } from "@/lib/env";
import type { NormalizedPaymentEvent } from "../services/billing";
import type { CheckoutRequest, PaymentProvider, VerifiedWebhook } from "./types";

export class StripePaymentProvider implements PaymentProvider {
  readonly name = "stripe";
  private stripe: Stripe;

  constructor(secretKey = env.stripeSecretKey, private webhookSecret = env.stripeWebhookSecret) {
    this.stripe = new Stripe(secretKey);
  }

  async createCheckout(req: CheckoutRequest) {
    const metadata = { school_id: req.schoolId, payment_id: req.paymentId };
    const session = await this.stripe.checkout.sessions.create(
      {
        mode: "payment",
        client_reference_id: req.paymentId,
        customer_email: req.customerEmail ?? undefined,
        line_items: [
          {
            quantity: 1,
            price_data: { currency: req.currency.toLowerCase(), unit_amount: req.amountCents, product_data: { name: req.description } },
          },
        ],
        metadata,
        payment_intent_data: { metadata, description: req.reference },
        success_url: req.successUrl,
        cancel_url: req.cancelUrl,
        // Short-lived by design: the e-mail links to /pay/<token>, which creates a fresh session when needed.
        expires_at: Math.floor(Date.now() / 1000) + 60 * 60 * 23,
      },
      { idempotencyKey: req.idempotencyKey, stripeAccount: req.connectedAccountId ?? undefined },
    );
    if (!session.url) throw new Error("Stripe did not return a checkout URL");
    return { url: session.url, providerCheckoutId: session.id };
  }

  async verifyWebhook(rawBody: string, headers: Headers): Promise<VerifiedWebhook> {
    const signature = headers.get("stripe-signature");
    if (!signature) throw new Error("Missing Stripe-Signature header");
    const event = this.stripe.webhooks.constructEvent(rawBody, signature, this.webhookSecret);
    return mapStripeEvent(event);
  }
}

/** Exported for tests. */
export function mapStripeEvent(event: Stripe.Event): VerifiedWebhook {
  const base = { provider: "stripe", eventId: event.id, eventType: event.type, raw: { id: event.id, type: event.type, account: event.account ?? null } };
  const ignored = (schoolId: string | null = null): VerifiedWebhook => ({
    schoolId,
    event: { ...base, kind: "ignored", paymentId: null, amountCents: null, currency: null, providerCheckoutId: null, providerPaymentId: null },
  });

  switch (event.type) {
    case "checkout.session.completed":
    case "checkout.session.async_payment_succeeded":
    case "checkout.session.async_payment_failed": {
      const s = event.data.object;
      const schoolId = s.metadata?.school_id ?? null;
      const paymentId = s.metadata?.payment_id ?? null;
      const kind: NormalizedPaymentEvent["kind"] =
        event.type === "checkout.session.async_payment_failed" ? "failed" : s.payment_status === "paid" ? "succeeded" : "ignored";
      return {
        schoolId,
        event: {
          ...base,
          kind,
          paymentId,
          amountCents: s.amount_total ?? null,
          currency: s.currency?.toUpperCase() ?? null,
          providerCheckoutId: s.id,
          providerPaymentId: typeof s.payment_intent === "string" ? s.payment_intent : (s.payment_intent?.id ?? null),
        },
      };
    }
    case "charge.refunded": {
      const c = event.data.object;
      if (!c.refunded) return ignored(); // partial refunds are handled manually
      return {
        schoolId: c.metadata?.school_id ?? null,
        event: {
          ...base,
          kind: "refunded",
          paymentId: c.metadata?.payment_id ?? null,
          amountCents: c.amount_refunded,
          currency: c.currency.toUpperCase(),
          providerCheckoutId: null,
          providerPaymentId: typeof c.payment_intent === "string" ? c.payment_intent : (c.payment_intent?.id ?? null),
        },
      };
    }
    default:
      return ignored();
  }
}
