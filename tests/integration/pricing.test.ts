import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DateTime } from "luxon";
import { closePools, one, withTenant } from "@/lib/db";
import { bookLesson, completeLesson } from "@/server/services/lessons";
import { applyProviderEvent } from "@/server/services/billing";
import { savePriceList, setLessonPrice } from "@/server/services/pricing";
import { asUser, createFixture, setLessonTime, slotAt, type Fixture } from "./helpers";

let f: Fixture;
beforeAll(async () => {
  f = await createFixture();
});
afterAll(closePools);

const book = (days: number, hour: number, lessonType: "practical" | "exam" = "practical") =>
  withTenant(f.schoolId, (tx) => bookLesson(tx, f.owner, { studentId: f.studentId, slot: slotAt(f, days, hour), bookedVia: "staff", lessonType }));

async function pastCompleted(days: number) {
  const l = await book(30 + days, 9);
  const start = DateTime.now().minus({ days }).startOf("hour");
  await setLessonTime(f, l.id, start.toJSDate(), start.plus({ hours: 1 }).toJSDate());
  const r = await withTenant(f.schoolId, (tx) => completeLesson(tx, f.owner, l.id, { paymentRequired: true }));
  return { lessonId: l.id, paymentId: r.paymentId! };
}

describe("owner pricing", () => {
  it("the owner changes an upcoming lesson's price; it is marked as set by hand and audited", async () => {
    const l = await book(3, 10);
    await withTenant(f.schoolId, (tx) => setLessonPrice(tx, f.owner, l.id, 6250, "Longer route"));
    const row = await withTenant(f.schoolId, (tx) => one<{ price_cents: number; price_overridden: boolean }>(tx, `SELECT price_cents, price_overridden FROM lessons WHERE id = $1`, [l.id]));
    expect(row).toEqual({ price_cents: 6250, price_overridden: true });
    const log = await withTenant(f.schoolId, (tx) => one<{ changes: { before_cents: number; after_cents: number } }>(tx, `SELECT changes FROM audit_logs WHERE entity_id = $1 AND action = 'lesson.price_changed'`, [l.id]));
    expect(log!.changes).toMatchObject({ before_cents: 5500, after_cents: 6250 });
  });

  it("only the owner may change prices", async () => {
    const l = await book(4, 10);
    await expect(withTenant(f.schoolId, (tx) => setLessonPrice(tx, asUser(f.instructorActor), l.id, 1000))).rejects.toMatchObject({ code: "forbidden" });
    const admin = { ...f.ownerActor, role: "school_admin" as const };
    await expect(withTenant(f.schoolId, (tx) => setLessonPrice(tx, asUser(admin), l.id, 1000))).rejects.toMatchObject({ code: "forbidden" });
  });

  it("repricing a billed, unpaid lesson updates invoice and payment and drops the old checkout", async () => {
    const { lessonId, paymentId } = await pastCompleted(2);
    await withTenant(f.schoolId, (tx) => tx.query(`UPDATE payments SET provider_checkout_id = 'cs_old', payment_link = 'https://old' WHERE id = $1`, [paymentId]));
    await withTenant(f.schoolId, (tx) => setLessonPrice(tx, f.owner, lessonId, 4000, "Discount"));
    const s = await withTenant(f.schoolId, (tx) =>
      one<{ amount_cents: number; provider_checkout_id: string | null; total_cents: number; unit_cents: number }>(
        tx,
        `SELECT p.amount_cents, p.provider_checkout_id, i.total_cents, ii.unit_cents
           FROM payments p JOIN invoices i ON i.id = p.invoice_id JOIN invoice_items ii ON ii.invoice_id = i.id WHERE p.id = $1`,
        [paymentId],
      ),
    );
    expect(s).toEqual({ amount_cents: 4000, provider_checkout_id: null, total_cents: 4000, unit_cents: 4000 });
    // A webhook for the old amount is refused; the new amount settles it.
    const stale = await withTenant(f.schoolId, (tx) =>
      applyProviderEvent(tx, f.schoolId, { provider: "stripe", eventId: "evt_old", eventType: "checkout.session.completed", kind: "succeeded", paymentId, amountCents: 5500, currency: "EUR", providerCheckoutId: "cs_old", providerPaymentId: "pi_old", raw: {} }),
    );
    expect(stale).toEqual({ applied: false, reason: "amount_mismatch" });
  });

  it("paid lessons cannot be repriced", async () => {
    const { lessonId, paymentId } = await pastCompleted(3);
    await withTenant(f.schoolId, (tx) =>
      applyProviderEvent(tx, f.schoolId, { provider: "stripe", eventId: `evt_${paymentId}`, eventType: "checkout.session.completed", kind: "succeeded", paymentId, amountCents: 5500, currency: "EUR", providerCheckoutId: "cs", providerPaymentId: "pi", raw: {} }),
    );
    await expect(withTenant(f.schoolId, (tx) => setLessonPrice(tx, f.owner, lessonId, 100))).rejects.toMatchObject({ code: "price_locked_paid" });
  });

  it("the price list sets type prices and can update upcoming unbilled lessons, except hand-set ones", async () => {
    const plain = await book(5, 10);
    const exam = await book(5, 13, "exam");
    const manual = await book(5, 15);
    await withTenant(f.schoolId, (tx) => setLessonPrice(tx, f.owner, manual.id, 9999));
    const r = await withTenant(f.schoolId, (tx) => savePriceList(tx, f.owner, { defaultPriceCents: 6000, typePrices: { practical: null, exam_prep: null, exam: 12000, assessment: null }, applyToUpcoming: true }));
    expect(r.updated).toBeGreaterThanOrEqual(2);
    const prices = await withTenant(f.schoolId, async (tx) =>
      Object.fromEntries(
        (await tx.query<{ id: string; price_cents: number }>(`SELECT id, price_cents FROM lessons WHERE id = ANY($1)`, [[plain.id, exam.id, manual.id]])).rows.map((x) => [x.id, x.price_cents]),
      ),
    );
    expect(prices[plain.id]).toBe(6000);
    expect(prices[exam.id]).toBe(12000);
    expect(prices[manual.id]).toBe(9999);
    // New bookings use the new list.
    const next = await book(6, 10, "exam");
    expect(next.price_cents).toBe(12000);
  });
});
