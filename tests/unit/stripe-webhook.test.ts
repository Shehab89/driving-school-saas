import { describe, expect, it } from "vitest";
import Stripe from "stripe";
import { StripePaymentProvider, mapStripeEvent } from "@/server/payments/stripe";

const SECRET = "whsec_test_secret_for_unit_tests";
const provider = new StripePaymentProvider("sk_test_dummy", SECRET);
const stripe = new Stripe("sk_test_dummy");

function signed(payload: object) {
  const body = JSON.stringify(payload);
  const header = stripe.webhooks.generateTestHeaderString({ payload: body, secret: SECRET });
  return { body, headers: new Headers({ "stripe-signature": header }) };
}

const session = (over: object = {}) => ({
  id: "evt_1",
  object: "event",
  type: "checkout.session.completed",
  data: { object: { id: "cs_1", object: "checkout.session", payment_status: "paid", amount_total: 5500, currency: "eur", payment_intent: "pi_1", metadata: { school_id: "s1", payment_id: "p1" }, ...over } },
});

describe("Stripe webhook verification", () => {
  it("accepts a correctly signed event and maps it", async () => {
    const { body, headers } = signed(session());
    const r = await provider.verifyWebhook(body, headers);
    expect(r.schoolId).toBe("s1");
    expect(r.event).toMatchObject({ kind: "succeeded", paymentId: "p1", amountCents: 5500, currency: "EUR", providerPaymentId: "pi_1" });
  });

  it("rejects a tampered body or a missing signature", async () => {
    const { headers } = signed(session());
    await expect(provider.verifyWebhook(JSON.stringify(session({ amount_total: 1 })), headers)).rejects.toThrow(/signature/i);
    await expect(provider.verifyWebhook(JSON.stringify(session()), new Headers())).rejects.toThrow(/Stripe-Signature/);
  });

  it("an unpaid completed session is not a success", () => {
    const r = mapStripeEvent(session({ payment_status: "unpaid" }) as unknown as Stripe.Event);
    expect(r.event.kind).toBe("ignored");
  });

  it("maps disputes by PaymentIntent, and their outcome", () => {
    const dispute = (type: string, status: string) =>
      mapStripeEvent({ id: "evt_d", type, data: { object: { object: "dispute", amount: 5500, currency: "eur", payment_intent: "pi_9", status } } } as unknown as Stripe.Event);
    expect(dispute("charge.dispute.created", "needs_response").event).toMatchObject({ kind: "disputed", providerPaymentId: "pi_9", paymentId: null });
    expect(dispute("charge.dispute.closed", "won").event.kind).toBe("dispute_won");
    expect(dispute("charge.dispute.closed", "lost").event.kind).toBe("dispute_lost");
    expect(dispute("charge.dispute.closed", "warning_closed").event.kind).toBe("ignored");
  });
});
