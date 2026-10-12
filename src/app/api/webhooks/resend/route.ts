import { NextResponse } from "next/server";
import { log } from "@/lib/log";
import { handleResendEvent, verifySvixSignature, WebhookSignatureError } from "@/server/email/webhook";

export const runtime = "nodejs";

/** Resend → us: delivery, bounce and complaint events. */
export async function POST(req: Request) {
  const secret = process.env.RESEND_WEBHOOK_SECRET;
  if (!secret) return NextResponse.json({ error: "not configured" }, { status: 503 });
  const raw = await req.text();
  try {
    verifySvixSignature(raw, req.headers, secret);
  } catch (err) {
    if (err instanceof WebhookSignatureError) return NextResponse.json({ error: "invalid signature" }, { status: 400 });
    throw err;
  }
  try {
    const result = await handleResendEvent(JSON.parse(raw));
    return NextResponse.json({ received: true, ...result });
  } catch (err) {
    log.error("resend.webhook_failed", { err });
    return NextResponse.json({ error: "processing failed" }, { status: 500 });
  }
}
