import { env } from "@/lib/env";

export interface WhatsAppSender {
  sendText(args: { phoneNumberId: string; accessToken: string; to: string; body: string }): Promise<{ waMessageId: string }>;
}

/** Meta Graph API (Cloud API) sender. */
export class CloudApiSender implements WhatsAppSender {
  async sendText({ phoneNumberId, accessToken, to, body }: { phoneNumberId: string; accessToken: string; to: string; body: string }) {
    const res = await fetch(`https://graph.facebook.com/${env.whatsappGraphVersion}/${encodeURIComponent(phoneNumberId)}/messages`, {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        recipient_type: "individual",
        to: to.replace(/^\+/, ""),
        type: "text",
        text: { preview_url: true, body: body.slice(0, 4096) },
      }),
    });
    const json = (await res.json().catch(() => ({}))) as { messages?: Array<{ id: string }>; error?: { message?: string; code?: number } };
    if (!res.ok || !json.messages?.[0]) {
      throw new Error(`WhatsApp send failed (${res.status}): ${json.error?.message ?? "unknown error"}`);
    }
    return { waMessageId: json.messages[0].id };
  }
}

/** Tests / local development without a Meta app. */
export class RecordingSender implements WhatsAppSender {
  readonly sent: Array<{ to: string; body: string }> = [];
  async sendText({ to, body }: { to: string; body: string }) {
    this.sent.push({ to, body });
    return { waMessageId: `wamid.test.${this.sent.length}.${Date.now()}` };
  }
}

let sender: WhatsAppSender | null = null;
export function getWhatsAppSender(): WhatsAppSender {
  return (sender ??= process.env.WHATSAPP_SENDER === "recording" ? new RecordingSender() : new CloudApiSender());
}
export function setWhatsAppSender(s: WhatsAppSender) {
  sender = s;
}
