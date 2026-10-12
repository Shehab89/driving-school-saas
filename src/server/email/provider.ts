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

/**
 * Spaces out calls so one process never exceeds `perSecond` (Resend's default
 * API limit is 2 requests per second per account). Callers queue in order.
 */
export function pacer(perSecond: number, now = () => Date.now(), sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))) {
  const gap = 1000 / perSecond;
  let next = 0;
  return async () => {
    const at = Math.max(now(), next);
    next = at + gap;
    const wait = at - now();
    if (wait > 0) await sleep(wait);
  };
}

class ResendProvider implements EmailProvider {
  readonly name = "resend";
  private client = new Resend(env.resendApiKey);
  private pace = pacer(env.emailMaxPerSecond);

  async send(msg: EmailMessage) {
    await this.pace();
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
