import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DateTime } from "luxon";
import { closePools, many, one, withTenant } from "@/lib/db";
import { bookLesson, completeLesson } from "@/server/services/lessons";
import { applyProviderEvent, recordManualPayment, type NormalizedPaymentEvent } from "@/server/services/billing";
import { deliverNotifications } from "@/server/jobs";
import { ConsoleEmailProvider, setEmailProvider } from "@/server/email/provider";
import { asUser, createFixture, setLessonTime, slotAt, type Fixture } from "./helpers";

let f: Fixture;
const email = new ConsoleEmailProvider();
beforeAll(async () => {
  f = await createFixture();
  setEmailProvider(email);
});
afterAll(closePools);

async function pastLesson(daysAgo: number) {
  const lesson = await withTenant(f.schoolId, (tx) => bookLesson(tx, f.owner, { studentId: f.studentId, slot: slotAt(f, 20 + daysAgo, 9), bookedVia: "staff" }));
  const start = DateTime.now().minus({ days: daysAgo }).startOf("hour");
  await setLessonTime(f, lesson.id, start.toJSDate(), start.plus({ hours: 1 }).toJSDate());
  return lesson;
}

const event = (paymentId: string, over: Partial<NormalizedPaymentEvent> = {}): NormalizedPaymentEvent => ({
  provider: "stripe",
  eventId: `evt_${Math.random()}`,
  eventType: "checkout.session.completed",
  kind: "succeeded",
  paymentId,
  amountCents: 5500,
  currency: "EUR",
  providerCheckoutId: "cs_test",
  providerPaymentId: `pi_${Math.random()}`,
  raw: {},
  ...over,
});

describe("lesson completion -> payment", () => {
  it("completing creates invoice + payment + e-mail with a secure pay link", async () => {
    const lesson = await pastLesson(1);
    const res = await withTenant(f.schoolId, (tx) =>
      completeLesson(tx, asUser(f.instructorActor), lesson.id, { feedback: { strengths: "Smooth clutch", weaknesses: "Mirrors", practiceItems: "Roundabouts", nextFocus: "Junctions" } }),
    );
    expect(res.paymentId).toBeTruthy();
    const state = await withTenant(f.schoolId, async (tx) => ({
      lesson: await one<{ status: string; payment_status: string }>(tx, `SELECT status, payment_status FROM lessons WHERE id = $1`, [lesson.id]),
      payment: await one<{ status: string; amount_cents: number; pay_token: string }>(tx, `SELECT status, amount_cents, pay_token FROM payments WHERE id = $1`, [res.paymentId]),
      notification: await one<{ type: string; payload: { pay_url: string } }>(tx, `SELECT type, payload FROM notifications WHERE payment_id = $1`, [res.paymentId]),
    }));
    expect(state.lesson).toEqual({ status: "completed", payment_status: "pending" });
    expect(state.payment).toMatchObject({ status: "pending", amount_cents: 5500 });
    expect(state.notification!.type).toBe("lesson_completed_payment_request");
    expect(state.notification!.payload.pay_url).toBe(`http://localhost:3000/pay/${state.payment!.pay_token}`);

    await deliverNotifications();
    const mail = email.sent.find((m) => m.subject.startsWith("Lesson completed"));
    expect(mail?.text).toContain("€55.00");
    expect(mail?.html).toContain(`/pay/${state.payment!.pay_token}`);
  });

  it("a completed lesson cannot be completed again or billed twice", async () => {
    const lesson = await pastLesson(2);
    await withTenant(f.schoolId, (tx) => completeLesson(tx, f.owner, lesson.id));
    await expect(withTenant(f.schoolId, (tx) => completeLesson(tx, f.owner, lesson.id))).rejects.toMatchObject({ code: "invalid_status" });
    const n = await withTenant(f.schoolId, (tx) => many(tx, `SELECT 1 FROM payments WHERE lesson_id = $1`, [lesson.id]));
    expect(n).toHaveLength(1);
  });

  it("students and other instructors cannot complete lessons", async () => {
    const lesson = await pastLesson(3);
    await expect(withTenant(f.schoolId, (tx) => completeLesson(tx, asUser(f.studentActor), lesson.id))).rejects.toMatchObject({ code: "forbidden" });
    const otherInstructor = { ...f.instructorActor, instructorId: "00000000-0000-4000-8000-000000000001" };
    await expect(withTenant(f.schoolId, (tx) => completeLesson(tx, asUser(otherInstructor), lesson.id))).rejects.toMatchObject({ code: "forbidden" });
  });

  it("a verified webhook marks the payment paid exactly once", async () => {
    const lesson = await pastLesson(4);
    const { paymentId } = await withTenant(f.schoolId, (tx) => completeLesson(tx, f.owner, lesson.id));
    const ev = event(paymentId!);
    const first = await withTenant(f.schoolId, (tx) => applyProviderEvent(tx, f.schoolId, ev));
    const again = await withTenant(f.schoolId, (tx) => applyProviderEvent(tx, f.schoolId, ev));
    expect(first).toEqual({ applied: true });
    expect(again).toEqual({ applied: false, reason: "duplicate" });
    const s = await withTenant(f.schoolId, async (tx) => ({
      pay: await one<{ status: string }>(tx, `SELECT status FROM payments WHERE id = $1`, [paymentId]),
      lesson: await one<{ payment_status: string }>(tx, `SELECT payment_status FROM lessons WHERE id = $1`, [lesson.id]),
      mails: await many(tx, `SELECT 1 FROM notifications WHERE payment_id = $1 AND type = 'payment_succeeded'`, [paymentId]),
    }));
    expect(s.pay!.status).toBe("paid");
    expect(s.lesson!.payment_status).toBe("paid");
    expect(s.mails).toHaveLength(1);
  });

  it("refuses to mark paid when the amount does not match", async () => {
    const lesson = await pastLesson(5);
    const { paymentId } = await withTenant(f.schoolId, (tx) => completeLesson(tx, f.owner, lesson.id));
    const r = await withTenant(f.schoolId, (tx) => applyProviderEvent(tx, f.schoolId, event(paymentId!, { amountCents: 100 })));
    expect(r).toEqual({ applied: false, reason: "amount_mismatch" });
    const p = await withTenant(f.schoolId, (tx) => one<{ status: string }>(tx, `SELECT status FROM payments WHERE id = $1`, [paymentId]));
    expect(p!.status).toBe("pending");
  });

  it("only staff can record a manual (cash) payment", async () => {
    const lesson = await pastLesson(6);
    const { paymentId } = await withTenant(f.schoolId, (tx) => completeLesson(tx, f.owner, lesson.id));
    await expect(withTenant(f.schoolId, (tx) => recordManualPayment(tx, asUser(f.instructorActor), paymentId!, "cash"))).rejects.toMatchObject({ code: "forbidden" });
    await withTenant(f.schoolId, (tx) => recordManualPayment(tx, f.owner, paymentId!, "cash"));
    const log = await withTenant(f.schoolId, (tx) => one<{ action: string }>(tx, `SELECT action FROM audit_logs WHERE entity_id = $1 AND action = 'payment.recorded_manually'`, [paymentId]));
    expect(log).toBeTruthy();
  });

  it("scrubs one-time secrets from notification payloads after sending", async () => {
    await deliverNotifications();
    const leftovers = await withTenant(f.schoolId, (tx) =>
      many(tx, `SELECT 1 FROM notifications WHERE status = 'sent' AND payload ? 'activation_url'`),
    );
    expect(leftovers).toEqual([]);
  });
});
