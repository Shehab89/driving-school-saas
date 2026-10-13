import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closePools, many, one, withPlatform, withTenant } from "@/lib/db";
import { allow } from "@/lib/rate-limit";
import { ConsoleEmailProvider, setEmailProvider, type EmailMessage, type EmailProvider } from "@/server/email/provider";
import { deliverNotifications, runAllJobs } from "@/server/jobs";
import { enqueueNotification } from "@/server/services/notifications";
import { createFixture, type Fixture } from "./helpers";

let f: Fixture;
beforeAll(async () => {
  f = await createFixture();
});
afterAll(closePools);

/** Drain whatever earlier test files left in the shared queue. */
async function drain() {
  setEmailProvider(new ConsoleEmailProvider());
  while ((await deliverNotifications()).claimed > 0);
}

class DownProvider implements EmailProvider {
  readonly name = "down";
  calls = 0;
  async send(_: EmailMessage): Promise<{ id: string }> {
    this.calls++;
    throw new Error("503 Service Unavailable");
  }
}

describe("notification outbox", () => {
  it("the same event enqueued twice produces one e-mail, even with two workers racing", async () => {
    await drain();
    const key = `test-dedupe:${f.studentId}`;
    const ids = await withTenant(f.schoolId, async (tx) => [
      await enqueueNotification(tx, { schoolId: f.schoolId, type: "payment_succeeded", to: "a@example.com", dedupeKey: key, payload: { amount_cents: 100, currency: "EUR" } }),
      await enqueueNotification(tx, { schoolId: f.schoolId, type: "payment_succeeded", to: "a@example.com", dedupeKey: key, payload: { amount_cents: 100, currency: "EUR" } }),
    ]);
    expect(ids[0]).toBeTruthy();
    expect(ids[1]).toBeNull();

    const email = new ConsoleEmailProvider();
    setEmailProvider(email);
    await Promise.all([deliverNotifications(), deliverNotifications(), deliverNotifications()]);
    expect(email.sent.filter((m) => m.to === "a@example.com")).toHaveLength(1);
  });

  it("a provider outage leaves e-mails queued with back-off, then marks them failed after 5 attempts", async () => {
    await drain();
    const id = (await withTenant(f.schoolId, (tx) =>
      enqueueNotification(tx, { schoolId: f.schoolId, type: "payment_succeeded", to: "outage@example.com", payload: { amount_cents: 100, currency: "EUR" } }),
    ))!;
    const down = new DownProvider();
    setEmailProvider(down);

    // The cron tick still completes; other jobs are not blocked by the failing provider.
    const tick = await runAllJobs();
    expect(tick).toMatchObject({ ok: true });
    let row = (await withPlatform((tx) => one<{ status: string; attempts: number; last_error: string; due_later: boolean }>(
      tx, `SELECT status, attempts, last_error, scheduled_for > now() AS due_later FROM notifications WHERE id = $1`, [id],
    )))!;
    expect(row).toMatchObject({ status: "queued", attempts: 1, due_later: true });
    expect(row.last_error).toMatch(/503/);

    for (let i = 0; i < 4; i++) {
      await withPlatform((tx) => tx.query(`UPDATE notifications SET scheduled_for = now() WHERE id = $1`, [id]));
      await deliverNotifications();
    }
    row = (await withPlatform((tx) => one(tx, `SELECT status, attempts FROM notifications WHERE id = $1`, [id])))! as typeof row;
    expect(row).toMatchObject({ status: "failed", attempts: 5 });
    // Nothing was reported as sent.
    const sent = await withPlatform((tx) => many(tx, `SELECT 1 FROM notifications WHERE id = $1 AND sent_at IS NOT NULL`, [id]));
    expect(sent).toEqual([]);
    setEmailProvider(new ConsoleEmailProvider());
  });

  it("one-time secrets are scrubbed from the payload after sending", async () => {
    await drain();
    const id = (await withTenant(f.schoolId, (tx) =>
      enqueueNotification(tx, { schoolId: f.schoolId, type: "password_reset", to: "scrub@example.com", payload: { reset_url: "http://x/reset/secret" } }),
    ))!;
    await deliverNotifications();
    const row = await withPlatform((tx) => one<{ payload: Record<string, unknown> }>(tx, `SELECT payload FROM notifications WHERE id = $1`, [id]));
    expect(row!.payload.reset_url).toBeUndefined();
  });
});

describe("shared rate limiter", () => {
  it("allows up to the limit per window, then refuses", async () => {
    const key = `test:${Math.random()}`;
    const results = [];
    for (let i = 0; i < 5; i++) results.push(await allow(key, 3, 60_000));
    expect(results).toEqual([true, true, true, false, false]);
    expect(await allow(`${key}:other`, 3, 60_000)).toBe(true);
  });
});
