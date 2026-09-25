import { NextResponse } from "next/server";
import { env } from "@/lib/env";
import { resolvePayLink } from "@/server/payments/checkout";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Stable link from e-mails: creates a fresh provider checkout and redirects to it. */
export async function GET(_req: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const r = await resolvePayLink(token);
  if (r.kind === "redirect") return NextResponse.redirect(r.url, 303);
  const message =
    r.kind === "already_paid" ? `This payment to ${r.schoolName} has already been received. Thank you!` : r.kind === "not_payable" ? `This payment is ${r.status}.` : "Payment link not found.";
  return new NextResponse(
    `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><title>Payment</title><body style="font-family:system-ui;max-width:480px;margin:64px auto;padding:0 16px"><h1>Payment</h1><p>${message}</p><p><a href="${env.appUrl}">Go to my dashboard</a></p></body>`,
    { status: r.kind === "not_found" ? 404 : 200, headers: { "content-type": "text/html; charset=utf-8" } },
  );
}
