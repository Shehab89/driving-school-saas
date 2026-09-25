import { NextResponse } from "next/server";
import { handlePaymentWebhook } from "@/server/payments/checkout";

export const runtime = "nodejs";

/** Stripe → us. The raw body is needed for signature verification. */
export async function POST(req: Request) {
  const raw = await req.text();
  try {
    const result = await handlePaymentWebhook("stripe", raw, req.headers);
    return NextResponse.json({ received: true, ...result });
  } catch (err) {
    const message = err instanceof Error ? err.message : "error";
    // 400 on signature problems (Stripe won't retry garbage); 500 otherwise so Stripe retries.
    const status = /signature|Stripe-Signature/i.test(message) ? 400 : 500;
    if (status === 500) console.error("[stripe webhook]", err);
    return NextResponse.json({ error: status === 400 ? "invalid signature" : "processing failed" }, { status });
  }
}
