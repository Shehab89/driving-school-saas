/**
 * Meta WhatsApp Cloud API webhook helpers (official Business Platform only).
 * Signature: X-Hub-Signature-256 = "sha256=" + HMAC_SHA256(app_secret, raw_body).
 */
import { verifyHmacSha256 } from "@/lib/crypto";

export function verifyMetaSignature(appSecret: string, rawBody: string, header: string | null): boolean {
  if (!header?.startsWith("sha256=")) return false;
  return verifyHmacSha256(appSecret, rawBody, header.slice("sha256=".length));
}

export interface InboundMessage {
  phoneNumberId: string;
  from: string; // E.164 with '+'
  waMessageId: string;
  timestamp: Date;
  type: string;
  text: string;
  profileName: string | null;
}

export interface StatusUpdate {
  phoneNumberId: string;
  waMessageId: string;
  status: "sent" | "delivered" | "read" | "failed";
}

interface MetaPayload {
  object?: string;
  entry?: Array<{
    changes?: Array<{
      field?: string;
      value?: {
        metadata?: { phone_number_id?: string };
        contacts?: Array<{ wa_id?: string; profile?: { name?: string } }>;
        messages?: Array<{
          id: string;
          from: string;
          timestamp: string;
          type: string;
          text?: { body?: string };
          button?: { text?: string };
          interactive?: { button_reply?: { title?: string }; list_reply?: { title?: string } };
        }>;
        statuses?: Array<{ id: string; status: string }>;
      };
    }>;
  }>;
}

export function parseWebhook(payload: unknown): { messages: InboundMessage[]; statuses: StatusUpdate[] } {
  const p = payload as MetaPayload;
  const messages: InboundMessage[] = [];
  const statuses: StatusUpdate[] = [];
  if (p?.object !== "whatsapp_business_account") return { messages, statuses };
  for (const entry of p.entry ?? []) {
    for (const change of entry.changes ?? []) {
      if (change.field !== "messages" || !change.value) continue;
      const phoneNumberId = change.value.metadata?.phone_number_id;
      if (!phoneNumberId) continue;
      for (const m of change.value.messages ?? []) {
        const contact = change.value.contacts?.find((c) => c.wa_id === m.from);
        const text =
          m.type === "text"
            ? (m.text?.body ?? "")
            : m.type === "button"
              ? (m.button?.text ?? "")
              : m.type === "interactive"
                ? (m.interactive?.button_reply?.title ?? m.interactive?.list_reply?.title ?? "")
                : `[${m.type} message]`;
        messages.push({
          phoneNumberId,
          from: m.from.startsWith("+") ? m.from : `+${m.from}`,
          waMessageId: m.id,
          timestamp: new Date(Number(m.timestamp) * 1000),
          type: m.type,
          text: text.slice(0, 4000),
          profileName: contact?.profile?.name ?? null,
        });
      }
      for (const s of change.value.statuses ?? []) {
        if (["sent", "delivered", "read", "failed"].includes(s.status)) {
          statuses.push({ phoneNumberId, waMessageId: s.id, status: s.status as StatusUpdate["status"] });
        }
      }
    }
  }
  return { messages, statuses };
}
