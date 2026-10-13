import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DateTime } from "luxon";
import { closePools, many, one, withTenant } from "@/lib/db";
import { bookLesson, cancelLesson, completeLesson, rescheduleLesson } from "@/server/services/lessons";
import { applyProviderEvent, recordManualPayment, refundPayment, voidInvoice, type NormalizedPaymentEvent } from "@/server/services/billing";
import { createPackage, purchasePackage, studentCredits } from "@/server/services/packages";
import { registerPaymentProvider } from "@/server/payments";
import type { CheckoutRequest, PaymentProvider, RefundRequest } from "@/server/payments/types";
import { asUser, createFixture, setLessonTime, slotAt, type Fixture } from "./helpers";

class FakeProvider implements PaymentProvider {
  readonly name = "stripe";
  refunds: RefundRequest[] = [];
  async createCheckout(req: CheckoutRequest) {
    return { url: `https://checkout.test/${req.paymentId}`, providerCheckoutId: `cs_${req.paymentId}` };
  }
  async refund(req: RefundRequest) {
    this.refunds.push(req);
    return { refundId: `re_${this.refunds.length}` };
  }
  async verifyWebhook(): Promise<never> {
    throw new Error("not used");
  }
}
const provider = new FakeProvider();

const ev = (paymentId: string | null, kind: NormalizedPaymentEvent["kind"], over: Partial<NormalizedPaymentEvent> = {}): NormalizedPaymentEvent => ({
  provider: "stripe",
  eventId: `evt_${Math.random()}`,
  eventType: kind,
  kind,
  paymentId,
  amountCents: null,
  currency: "EUR",
  providerCheckoutId: null,
  providerPaymentId: null,
  raw: {},
  ...over,
});

async function pay(f: Fixture, paymentId: string) {
  const p = (await withTenant(f.schoolId, (tx) => one<{ amount_cents: number }>(tx, `SELECT amount_cents FROM payments WHERE id = $1`, [paymentId])))!;
  const pi = `pi_${Math.random().toString(36).slice(2)}`;
  await withTenant(f.schoolId, (tx) => applyProviderEvent(tx, f.schoolId, ev(paymentId, "succeeded", { amountCents: p.amount_cents, providerPaymentId: pi })));
  return pi;
}

async function pastLesson(f: Fixture, day: number, by = f.owner) {
  const lesson = await withTenant(f.schoolId, (tx) => bookLesson(tx, by, { studentId: f.studentId, slot: slotAt(f, 25 + day, 9), bookedVia: "staff" }));
  const start = DateTime.now().minus({ days: day }).startOf("hour");
  await setLessonTime(f, lesson.id, start.toJSDate(), start.plus({ hours: 1 }).toJSDate());
  return lesson;
}

beforeAll(() => registerPaymentProvider("stripe", provider));
afterAll(closePools);

describe("VAT on invoices", () => {
  let f: Fixture;
  beforeAll(async () => {
    f = await createFixture();
  });

  it("splits 21% VAT out of VAT-inclusive prices and freezes the rate on the invoice", async () => {
    const lesson = await pastLesson(f, 1);
    const r = await withTenant(f.schoolId, (tx) => completeLesson(tx, asUser(f.instructorActor), lesson.id));
    const inv = await withTenant(f.schoolId, (tx) =>
      one(tx, `SELECT i.subtotal_cents, i.tax_cents, i.total_cents, i.vat_rate_bps, p.amount_cents FROM invoices i JOIN payments p ON p.invoice_id = i.id WHERE p.id = $1`, [r.paymentId]),
    );
    expect(inv).toEqual({ subtotal_cents: 4545, tax_cents: 955, total_cents: 5500, vat_rate_bps: 2100, amount_cents: 5500 });
  });

  it("adds VAT on top when the school's prices exclude VAT", async () => {
    await withTenant(f.schoolId, (tx) => tx.query(`UPDATE school_settings SET prices_include_vat = false`));
    const lesson = await pastLesson(f, 2);
    const r = await withTenant(f.schoolId, (tx) => completeLesson(tx, asUser(f.instructorActor), lesson.id));
    const inv = await withTenant(f.schoolId, (tx) =>
      one(tx, `SELECT i.subtotal_cents, i.tax_cents, i.total_cents, p.amount_cents FROM invoices i JOIN payments p ON p.invoice_id = i.id WHERE p.id = $1`, [r.paymentId]),
    );
    expect(inv).toEqual({ subtotal_cents: 5500, tax_cents: 1155, total_cents: 6655, amount_cents: 6655 });
    await withTenant(f.schoolId, (tx) => tx.query(`UPDATE school_settings SET prices_include_vat = true`));
  });
});

describe("pay in advance (at_booking)", () => {
  let f: Fixture;
  beforeAll(async () => {
    f = await createFixture();
    await withTenant(f.schoolId, (tx) => tx.query(`UPDATE school_settings SET payment_mode = 'at_booking'`));
  });

  it("booking issues the invoice, due no later than the lesson day; completion does not bill twice", async () => {
    const lesson = await withTenant(f.schoolId, (tx) => bookLesson(tx, asUser(f.studentActor), { studentId: f.studentId, slot: slotAt(f, 2, 10), bookedVia: "student_portal" }));
    const rows = await withTenant(f.schoolId, (tx) => many<{ id: string; due_date: string; status: string }>(tx, `SELECT id, due_date, status FROM payments WHERE lesson_id = $1`, [lesson.id]));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe("pending");
    expect(rows[0]!.due_date <= DateTime.fromJSDate(lesson.start_time).setZone(f.timezone).toISODate()!).toBe(true);
    const n = await withTenant(f.schoolId, (tx) => one<{ type: string }>(tx, `SELECT type FROM notifications WHERE payment_id = $1`, [rows[0]!.id]));
    expect(n!.type).toBe("booking_payment_request");

    const start = DateTime.now().minus({ hours: 2 }).startOf("hour");
    await setLessonTime(f, lesson.id, start.toJSDate(), start.plus({ hours: 1 }).toJSDate());
    const done = await withTenant(f.schoolId, (tx) => completeLesson(tx, asUser(f.instructorActor), lesson.id));
    expect(done.paymentId).toBe(rows[0]!.id);
    const count = await withTenant(f.schoolId, (tx) => many(tx, `SELECT 1 FROM payments WHERE lesson_id = $1`, [lesson.id]));
    expect(count).toHaveLength(1);
  });

  it("rescheduling keeps the invoice with the lesson; cancelling in time voids an unpaid invoice", async () => {
    const lesson = await withTenant(f.schoolId, (tx) => bookLesson(tx, asUser(f.studentActor), { studentId: f.studentId, slot: slotAt(f, 5, 10), bookedVia: "student_portal" }));
    const moved = await withTenant(f.schoolId, (tx) => rescheduleLesson(tx, asUser(f.studentActor), lesson.id, slotAt(f, 6, 11), { channel: "student_portal" }));
    const pay1 = await withTenant(f.schoolId, (tx) => one<{ lesson_id: string; status: string; invoice_id: string }>(tx, `SELECT lesson_id, status, invoice_id FROM payments WHERE lesson_id IN ($1,$2)`, [lesson.id, moved.newLessonId]));
    expect(pay1!.lesson_id).toBe(moved.newLessonId);
    const newLesson = await withTenant(f.schoolId, (tx) => one<{ payment_status: string }>(tx, `SELECT payment_status FROM lessons WHERE id = $1`, [moved.newLessonId]));
    expect(newLesson!.payment_status).toBe("pending");

    await withTenant(f.schoolId, (tx) => cancelLesson(tx, asUser(f.studentActor), moved.newLessonId!, "Sick"));
    const after = await withTenant(f.schoolId, (tx) => one(tx, `SELECT p.status AS payment, i.status AS invoice, i.void_reason IS NOT NULL AS has_reason FROM payments p JOIN invoices i ON i.id = p.invoice_id WHERE p.invoice_id = $1`, [pay1!.invoice_id]));
    expect(after).toEqual({ payment: "cancelled", invoice: "void", has_reason: true });
  });

  it("a paid advance invoice is not voided on cancellation; it is flagged for refund", async () => {
    const lesson = await withTenant(f.schoolId, (tx) => bookLesson(tx, asUser(f.studentActor), { studentId: f.studentId, slot: slotAt(f, 8, 10), bookedVia: "student_portal" }));
    const payment = (await withTenant(f.schoolId, (tx) => one<{ id: string }>(tx, `SELECT id FROM payments WHERE lesson_id = $1`, [lesson.id])))!;
    await pay(f, payment.id);
    await withTenant(f.schoolId, (tx) => cancelLesson(tx, asUser(f.studentActor), lesson.id, "Plans changed"));
    const state = await withTenant(f.schoolId, async (tx) => ({
      payment: (await one<{ status: string }>(tx, `SELECT status FROM payments WHERE id = $1`, [payment.id]))!.status,
      flagged: (await many(tx, `SELECT 1 FROM audit_logs WHERE action = 'payment.refund_due' AND entity_id = $1`, [lesson.id])).length,
    }));
    expect(state).toEqual({ payment: "paid", flagged: 1 });
  });
});

describe("lesson packages (credits)", () => {
  let f: Fixture;
  let packageId: string;
  beforeAll(async () => {
    f = await createFixture();
    await withTenant(f.schoolId, (tx) => tx.query(`UPDATE school_settings SET payment_mode = 'credits'`));
    packageId = (await withTenant(f.schoolId, (tx) => createPackage(tx, f.owner, { name: "10 lessons", lessonCount: 10, priceCents: 52000 }))).id;
  });

  it("a student without credit cannot book; buying a package gives credit only after payment", async () => {
    await expect(
      withTenant(f.schoolId, (tx) => bookLesson(tx, asUser(f.studentActor), { studentId: f.studentId, slot: slotAt(f, 3, 10), bookedVia: "student_portal" })),
    ).rejects.toMatchObject({ code: "no_credit" });

    const buy = await withTenant(f.schoolId, (tx) => purchasePackage(tx, asUser(f.studentActor), { studentId: f.studentId, packageId }));
    // A second click reuses the same unpaid purchase.
    const again = await withTenant(f.schoolId, (tx) => purchasePackage(tx, asUser(f.studentActor), { studentId: f.studentId, packageId }));
    expect(again.paymentId).toBe(buy.paymentId);
    expect((await withTenant(f.schoolId, (tx) => studentCredits(tx, f.studentId))).balance).toBe(0);

    // A failed payment grants nothing.
    await withTenant(f.schoolId, (tx) => applyProviderEvent(tx, f.schoolId, ev(buy.paymentId, "failed")));
    expect((await withTenant(f.schoolId, (tx) => studentCredits(tx, f.studentId))).balance).toBe(0);

    const pi = await pay(f, buy.paymentId);
    const c = await withTenant(f.schoolId, (tx) => studentCredits(tx, f.studentId));
    expect(c.balance).toBe(10);

    // Replayed webhook: still 10.
    await withTenant(f.schoolId, (tx) => applyProviderEvent(tx, f.schoolId, ev(buy.paymentId, "succeeded", { amountCents: 52000, providerPaymentId: pi })));
    expect((await withTenant(f.schoolId, (tx) => studentCredits(tx, f.studentId))).balance).toBe(10);
  });

  it("completed lessons use one credit each and create no invoice", async () => {
    const lesson = await pastLesson(f, 1);
    const r = await withTenant(f.schoolId, (tx) => completeLesson(tx, asUser(f.instructorActor), lesson.id));
    expect(r.paymentId).toBeNull();
    const state = await withTenant(f.schoolId, async (tx) => ({
      lesson: (await one<{ payment_status: string }>(tx, `SELECT payment_status FROM lessons WHERE id = $1`, [lesson.id]))!.payment_status,
      credits: await studentCredits(tx, f.studentId),
    }));
    expect(state.lesson).toBe("prepaid");
    expect(state.credits.balance).toBe(9);
  });

  it("only staff can correct credits, with a note; refunding the package takes the credits back", async () => {
    const { adjustCredits } = await import("@/server/services/billing");
    await expect(withTenant(f.schoolId, (tx) => adjustCredits(tx, asUser(f.studentActor), f.studentId, 5, "free"))).rejects.toThrow(/not allowed/);
    await withTenant(f.schoolId, (tx) => adjustCredits(tx, f.owner, f.studentId, 1, "Goodwill: instructor was late"));
    expect((await withTenant(f.schoolId, (tx) => studentCredits(tx, f.studentId))).balance).toBe(10);

    const purchasePayment = (await withTenant(f.schoolId, (tx) =>
      one<{ id: string; provider_payment_id: string }>(tx, `SELECT pay.id, pay.provider_payment_id FROM package_purchases pp JOIN payments pay ON pay.invoice_id = pp.invoice_id WHERE pp.student_id = $1`, [f.studentId]),
    ))!;
    await withTenant(f.schoolId, (tx) => applyProviderEvent(tx, f.schoolId, ev(purchasePayment.id, "refunded", { providerPaymentId: purchasePayment.provider_payment_id })));
    expect((await withTenant(f.schoolId, (tx) => studentCredits(tx, f.studentId))).balance).toBe(0);
  });
});

describe("refunds, disputes and corrections", () => {
  let f: Fixture;
  beforeAll(async () => {
    f = await createFixture();
  });

  async function paidLesson(day: number) {
    const lesson = await pastLesson(f, day);
    const r = await withTenant(f.schoolId, (tx) => completeLesson(tx, asUser(f.instructorActor), lesson.id));
    const pi = await pay(f, r.paymentId!);
    return { paymentId: r.paymentId!, pi, lessonId: lesson.id };
  }

  it("only the owner refunds; a card refund waits for the provider's confirmation", async () => {
    const { paymentId, pi } = await paidLesson(1);
    await expect(withTenant(f.schoolId, (tx) => refundPayment(tx, asUser(f.instructorActor), paymentId, "x"))).rejects.toThrow(/not allowed/);
    const r = await withTenant(f.schoolId, (tx) => refundPayment(tx, f.owner, paymentId, "Lesson cut short"));
    expect(r).toBe("requested");
    expect(provider.refunds.at(-1)).toMatchObject({ providerPaymentId: pi, amountCents: 5500, idempotencyKey: `refund:${paymentId}` });
    // Not refunded until the provider confirms.
    expect((await withTenant(f.schoolId, (tx) => one<{ status: string }>(tx, `SELECT status FROM payments WHERE id = $1`, [paymentId])))!.status).toBe("paid");
    await withTenant(f.schoolId, (tx) => applyProviderEvent(tx, f.schoolId, ev(paymentId, "refunded", { providerPaymentId: pi })));
    expect((await withTenant(f.schoolId, (tx) => one<{ status: string }>(tx, `SELECT status FROM payments WHERE id = $1`, [paymentId])))!.status).toBe("refunded");
  });

  it("cash payments are refunded on the owner's word, with an audit entry", async () => {
    const lesson = await pastLesson(f, 2);
    const r = await withTenant(f.schoolId, (tx) => completeLesson(tx, asUser(f.instructorActor), lesson.id));
    await withTenant(f.schoolId, (tx) => recordManualPayment(tx, f.owner, r.paymentId!, "cash"));
    expect(await withTenant(f.schoolId, (tx) => refundPayment(tx, f.owner, r.paymentId!, "Paid twice"))).toBe("refunded");
    const audit = await withTenant(f.schoolId, (tx) => many(tx, `SELECT 1 FROM audit_logs WHERE action = 'payment.refunded_manually' AND entity_id = $1`, [r.paymentId]));
    expect(audit).toHaveLength(1);
  });

  it("disputes: paid → disputed → won is paid again; lost counts as refunded", async () => {
    const a = await paidLesson(3);
    await withTenant(f.schoolId, (tx) => applyProviderEvent(tx, f.schoolId, ev(null, "disputed", { providerPaymentId: a.pi })));
    const status = async (id: string) => (await withTenant(f.schoolId, (tx) => one<{ status: string }>(tx, `SELECT status FROM payments WHERE id = $1`, [id])))!.status;
    expect(await status(a.paymentId)).toBe("disputed");
    const owners = await withTenant(f.schoolId, (tx) => many(tx, `SELECT 1 FROM notifications WHERE type = 'payment_disputed' AND payment_id = $1`, [a.paymentId]));
    expect(owners.length).toBeGreaterThan(0);
    await withTenant(f.schoolId, (tx) => applyProviderEvent(tx, f.schoolId, ev(null, "dispute_won", { providerPaymentId: a.pi })));
    expect(await status(a.paymentId)).toBe("paid");

    const b = await paidLesson(4);
    await withTenant(f.schoolId, (tx) => applyProviderEvent(tx, f.schoolId, ev(null, "disputed", { providerPaymentId: b.pi })));
    await withTenant(f.schoolId, (tx) => applyProviderEvent(tx, f.schoolId, ev(null, "dispute_lost", { providerPaymentId: b.pi })));
    expect(await status(b.paymentId)).toBe("refunded");
  });

  it("voiding needs a reason and is refused for paid invoices", async () => {
    const lesson = await pastLesson(f, 5);
    const r = await withTenant(f.schoolId, (tx) => completeLesson(tx, asUser(f.instructorActor), lesson.id));
    const invoiceId = (await withTenant(f.schoolId, (tx) => one<{ invoice_id: string }>(tx, `SELECT invoice_id FROM payments WHERE id = $1`, [r.paymentId])))!.invoice_id;
    await expect(withTenant(f.schoolId, (tx) => voidInvoice(tx, f.owner, invoiceId, " "))).rejects.toThrow(/reason/);
    await withTenant(f.schoolId, (tx) => voidInvoice(tx, f.owner, invoiceId, "Trial lesson is free"));
    const lessonRow = await withTenant(f.schoolId, (tx) => one<{ payment_status: string }>(tx, `SELECT payment_status FROM lessons WHERE id = $1`, [lesson.id]));
    expect(lessonRow!.payment_status).toBe("not_required");

    const paid = await paidLesson(6);
    const paidInvoice = (await withTenant(f.schoolId, (tx) => one<{ invoice_id: string }>(tx, `SELECT invoice_id FROM payments WHERE id = $1`, [paid.paymentId])))!.invoice_id;
    await expect(withTenant(f.schoolId, (tx) => voidInvoice(tx, f.owner, paidInvoice, "oops"))).rejects.toMatchObject({ code: "invoice_paid" });
  });

  it("the ledger cannot be edited", async () => {
    await expect(withTenant(f.schoolId, (tx) => tx.query(`UPDATE student_credit_ledger SET delta = 100`))).rejects.toThrow(/permission denied/);
  });
});
