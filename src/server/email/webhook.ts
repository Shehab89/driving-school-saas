/**
 * Resend delivery events (sent through Svix). We verify the signature, then
 * record the delivery status on the notification and suppress addresses that
 * hard-bounce or report spam, so the school's sending reputation is protected.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { withPlatform } from "@/lib/db";
import { log } from "@/lib/log";

const TOLERANCE_SECONDS = 5 * 60;

export class WebhookSignatureError extends Error {}

/** Svix scheme: base64(HMAC-SHA256(secret, `${id}.${timestamp}.${body}`)), header "v1,<sig> v1,<sig2>". */
export function verifySvixSignature(rawBody: string, headers: Headers, secret: string, now = Date.now()): void {
  const id = headers.get("svix-id");
  const ts = headers.get("svix-timestamp");
  const sigHeader = headers.get("svix-signature");
  if (!id || !ts || !sigHeader) throw new WebhookSignatureError("missing signature headers");
  const tsNum = Number(ts);
  if (!Number.isFinite(tsNum) || Math.abs(now / 1000 - tsNum) > TOLERANCE_SECONDS) throw new WebhookSignatureError("timestamp outside tolerance");
  const key = Buffer.from(secret.replace(/^whsec_/, ""), "base64");
  const expected = createHmac("sha256", key).update(`${id}.${ts}.${rawBody}`).digest();
  const ok = sigHeader.split(" ").some((part) => {
    const [version, sig] = part.split(",");
    if (version !== "v1" || !sig) return false;
    const given = Buffer.from(sig, "base64");
    return given.length === expected.length && timingSafeEqual(given, expected);
  });
  if (!ok) throw new WebhookSignatureError("signature mismatch");
}

interface ResendEvent {
  type: string;
  data?: { email_id?: string; to?: string[]; bounce?: { type?: string } };
}

const STATUS: Record<string, "delivered" | "delayed" | "bounced" | "complained"> = {
  "email.delivered": "delivered",
  "email.delivery_delayed": "delayed",
  "email.bounced": "bounced",
  "email.complained": "complained",
};

export async function handleResendEvent(event: ResendEvent): Promise<{ applied: boolean }> {
  const status = STATUS[event.type];
  const emailId = event.data?.email_id;
  if (!status || !emailId) return { applied: false };
  // Routing by provider message id spans tenants, so this runs as the platform role.
  return withPlatform(async (tx) => {
    const r = await tx.query<{ id: string; to_address: string }>(
      `UPDATE notifications SET delivery_status = $2, delivery_updated_at = now()
        WHERE provider = 'resend' AND provider_message_id = $1
          -- never downgrade a final state (a late "delayed" after "bounced")
          AND (delivery_status IS NULL OR (delivery_status IN ('delayed','delivered') AND $2 <> 'delayed'))
        RETURNING id, to_address`,
      [emailId, status],
    );
    const row = r.rows[0];
    const transientBounce = status === "bounced" && /transient|temporary/i.test(event.data?.bounce?.type ?? "");
    if (row && (status === "complained" || (status === "bounced" && !transientBounce))) {
      await tx.query(
        `INSERT INTO email_suppressions (email, reason, source_notification_id) VALUES ($1,$2,$3) ON CONFLICT (email) DO NOTHING`,
        [row.to_address, status, row.id],
      );
      log.warn("email.suppressed", { notificationId: row.id, reason: status });
    }
    return { applied: Boolean(row) };
  });
}
