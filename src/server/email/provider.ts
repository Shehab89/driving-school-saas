/**
 * Transactional e-mail behind a small interface, so the provider can be
 * swapped (Resend today; Postmark/SES/SMTP later) without touching callers.
 */
import { Resend } from "resend";
import { env } from "@/lib/env";

export interface EmailMessage {
  to: string;
  subject: string;
  html: string;
  text: string;
  replyTo?: string;
  fromName?: string;
  /** Provider-side idempotency so a retried job never sends twice. */
  idempotencyKey?: string;
  tags?: Record<string, string>;
}

export interface EmailProvider {
  readonly name: string;
  send(msg: EmailMessage): Promise<{ id: string }>;
}

class ResendProvider implements EmailProvider {
  readonly name = "resend";
  private client = new Resend(env.resendApiKey);

  async send(msg: EmailMessage) {
    const from = msg.fromName ? `${msg.fromName.replace(/[<>"]/g, "")} <${extractAddress(env.emailFrom)}>` : env.emailFrom;
    const { data, error } = await this.client.emails.send(
      {
        from,
        to: [msg.to],
        subject: msg.subject,
        html: msg.html,
        text: msg.text,
        replyTo: msg.replyTo,
        tags: msg.tags ? Object.entries(msg.tags).map(([name, value]) => ({ name, value: value.replace(/[^a-zA-Z0-9_-]/g, "_") })) : undefined,
      },
      msg.idempotencyKey ? { idempotencyKey: msg.idempotencyKey } : undefined,
    );
    if (error || !data) throw new Error(`Resend error: ${error?.message ?? "unknown"}`);
    return { id: data.id };
  }
}

/** Development / tests: logs instead of sending. */
export class ConsoleEmailProvider implements EmailProvider {
  readonly name = "console";
  readonly sent: EmailMessage[] = [];
  async send(msg: EmailMessage) {
    this.sent.push(msg);
    if (process.env.NODE_ENV !== "test") console.log(`[email] to=${msg.to} subject="${msg.subject}"\n${msg.text}\n`);
    return { id: `console-${this.sent.length}` };
  }
}

function extractAddress(from: string) {
  return from.match(/<([^>]+)>/)?.[1] ?? from;
}

let provider: EmailProvider | null = null;
export function getEmailProvider(): EmailProvider {
  if (!provider) provider = env.emailProvider === "resend" ? new ResendProvider() : new ConsoleEmailProvider();
  return provider;
}
export function setEmailProvider(p: EmailProvider) {
  provider = p;
}
