import { env } from "@/lib/env";

export interface TemplateArgs {
  phoneNumberId: string;
  accessToken: string;
  to: string;
  /** Name and language of a template approved in the school's Meta WhatsApp Manager. */
  name: string;
  language: string;
  params: string[];
}

export interface WhatsAppSender {
  sendText(args: { phoneNumberId: string; accessToken: string; to: string; body: string }): Promise<{ waMessageId: string }>;
  /** Business-initiated messages (outside the 24-hour window) must use an approved template. */
  sendTemplate(args: TemplateArgs): Promise<{ waMessageId: string }>;
}

async function graphSend(phoneNumberId: string, accessToken: string, body: Record<string, unknown>) {
  const res = await fetch(`https://graph.facebook.com/${env.whatsappGraphVersion}/${encodeURIComponent(phoneNumberId)}/messages`, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ messaging_product: "whatsapp", recipient_type: "individual", ...body }),
  });
  const json = (await res.json().catch(() => ({}))) as { messages?: Array<{ id: string }>; error?: { message?: string; code?: number } };
  if (!res.ok || !json.messages?.[0]) {
    throw new Error(`WhatsApp send failed (${res.status}): ${json.error?.message ?? "unknown error"}`);
  }
  return { waMessageId: json.messages[0].id };
}

/** Meta Graph API (Cloud API) sender. */
export class CloudApiSender implements WhatsAppSender {
  async sendText({ phoneNumberId, accessToken, to, body }: { phoneNumberId: string; accessToken: string; to: string; body: string }) {
    return graphSend(phoneNumberId, accessToken, { to: to.replace(/^\+/, ""), type: "text", text: { preview_url: true, body: body.slice(0, 4096) } });
  }

  async sendTemplate({ phoneNumberId, accessToken, to, name, language, params }: TemplateArgs) {
    return graphSend(phoneNumberId, accessToken, {
      to: to.replace(/^\+/, ""),
      type: "template",
      template: {
        name,
        language: { code: language },
        components: params.length ? [{ type: "body", parameters: params.map((text) => ({ type: "text", text: text.slice(0, 1000) })) }] : [],
      },
    });
  }
}

/** Tests / local development without a Meta app. */
export class RecordingSender implements WhatsAppSender {
  readonly sent: Array<{ to: string; body: string }> = [];
  readonly templates: Array<{ to: string; name: string; language: string; params: string[] }> = [];
  async sendText({ to, body }: { to: string; body: string }) {
    this.sent.push({ to, body });
    return { waMessageId: `wamid.test.${this.sent.length}.${Date.now()}` };
  }
  async sendTemplate({ to, name, language, params }: TemplateArgs) {
    this.templates.push({ to, name, language, params });
    return { waMessageId: `wamid.tpl.${this.templates.length}.${Date.now()}` };
  }
}

let sender: WhatsAppSender | null = null;
export function getWhatsAppSender(): WhatsAppSender {
  return (sender ??= process.env.WHATSAPP_SENDER === "recording" ? new RecordingSender() : new CloudApiSender());
}
export function setWhatsAppSender(s: WhatsAppSender) {
  sender = s;
}
