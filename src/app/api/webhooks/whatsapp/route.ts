import { NextResponse, after } from "next/server";
import { env } from "@/lib/env";
import { parseWebhook, verifyMetaSignature } from "@/server/whatsapp/webhook";
import { ingestWebhook, processConversation } from "@/server/whatsapp/inbound";

export const runtime = "nodejs";

/** Meta webhook verification handshake. */
export async function GET(req: Request) {
  const url = new URL(req.url);
  if (url.searchParams.get("hub.mode") === "subscribe" && url.searchParams.get("hub.verify_token") === env.whatsappVerifyToken) {
    return new Response(url.searchParams.get("hub.challenge") ?? "", { status: 200 });
  }
  return new Response("forbidden", { status: 403 });
}

/** Inbound messages / delivery statuses. Store fast, answer after responding. */
export async function POST(req: Request) {
  const raw = await req.text();
  if (!verifyMetaSignature(env.metaAppSecret, raw, req.headers.get("x-hub-signature-256"))) {
    return new Response("invalid signature", { status: 401 });
  }
  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    return new Response("bad json", { status: 400 });
  }
  const { messages, statuses } = parseWebhook(payload);
  const conversations = await ingestWebhook(messages, statuses);
  // Anything not finished here is picked up by the cron tick.
  after(async () => {
    for (const c of conversations) await processConversation(c.schoolId, c.conversationId).catch((e) => console.error("[whatsapp]", e));
  });
  return NextResponse.json({ ok: true });
}
