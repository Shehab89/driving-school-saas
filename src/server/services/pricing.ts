/**
 * Owner-managed pricing.
 *  - setLessonPrice: change one lesson's price. If the lesson was already
 *    billed and is still unpaid, the invoice line, invoice total and payment
 *    amount follow, the old checkout link is dropped (a fresh one is created
 *    on the next click) and the student gets an updated payment request.
 *    Paid or refunded lessons are locked: refund in the payment provider instead.
 *  - savePriceList: default price + price per lesson type, optionally applied to
 *    upcoming, unbilled lessons whose price was not set by hand.
 */
import { z } from "zod";
import { many, one, type Tx } from "@/lib/db";
import { ForbiddenError, PolicyError } from "@/lib/errors";
import { can } from "@/lib/rbac";
import type { Principal } from "../principal";
import { loadSchoolContext } from "../scheduling/loader";
import { audit } from "./audit";
import { enqueueNotification } from "./notifications";
import { lessonSnapshot, lockLesson, priceForDuration, type LessonType } from "./lessons";
import { payUrl } from "./billing";

function assertPricing(p: Principal) {
  if (p.type !== "user" || !can(p.actor.role, "pricing:write")) throw new ForbiddenError("Only the school owner can change prices.");
}

const cents = z.number().int().min(0).max(1_000_000);

export async function setLessonPrice(tx: Tx, p: Principal, lessonId: string, priceCents: number, reason?: string) {
  assertPricing(p);
  cents.parse(priceCents);
  const lesson = await lockLesson(tx, lessonId);
  if (["cancelled", "rescheduled"].includes(lesson.status)) {
    throw new PolicyError("The price of a cancelled or moved lesson can't be changed.", "invalid_status");
  }
  if (lesson.price_cents === priceCents) return { changed: false as const };

  const payment = await one<{ id: string; invoice_id: string; invoice_number: string; status: string; pay_token: string; due_date: string; student_email: string | null }>(
    tx,
    `SELECT pay.id, pay.invoice_id, inv.invoice_number, pay.status, pay.pay_token, pay.due_date, s.email AS student_email
       FROM invoice_items ii JOIN payments pay ON pay.invoice_id = ii.invoice_id JOIN invoices inv ON inv.id = pay.invoice_id
       JOIN students s ON s.id = pay.student_id
      WHERE ii.lesson_id = $1 AND ii.kind = 'lesson'
      ORDER BY pay.created_at DESC LIMIT 1 FOR UPDATE OF pay, inv`,
    [lessonId],
  );
  if (payment && ["paid", "refunded"].includes(payment.status)) {
    throw new PolicyError("This lesson has already been paid. Refund the payment instead of changing the price.", "price_locked_paid");
  }

  await tx.query(`UPDATE lessons SET price_cents = $2, price_overridden = true WHERE id = $1`, [lessonId, priceCents]);

  if (payment) {
    if (priceCents === 0) {
      // Free after all: cancel the open payment and invoice.
      await tx.query(`UPDATE payments SET status = 'cancelled', payment_link = NULL, provider_checkout_id = NULL WHERE id = $1`, [payment.id]);
      await tx.query(`UPDATE invoices SET status = 'void' WHERE id = $1`, [payment.invoice_id]);
      await tx.query(`UPDATE lessons SET payment_status = 'not_required' WHERE id = $1`, [lessonId]);
    } else {
      await tx.query(`UPDATE invoice_items SET unit_cents = $2 WHERE invoice_id = $1 AND lesson_id = $3 AND kind = 'lesson'`, [payment.invoice_id, priceCents, lessonId]);
      await tx.query(
        `UPDATE invoices SET subtotal_cents = (SELECT COALESCE(sum(amount_cents), 0) FROM invoice_items WHERE invoice_id = $1) WHERE id = $1`,
        [payment.invoice_id],
      );
      // Drop the old checkout so the student can never pay the old amount through a new click.
      await tx.query(`UPDATE payments SET amount_cents = $2, payment_link = NULL, provider_checkout_id = NULL WHERE id = $1`, [payment.id, priceCents]);
      await enqueueNotification(tx, {
        schoolId: p.schoolId,
        type: "lesson_completed_payment_request",
        to: payment.student_email,
        studentId: lesson.student_id,
        lessonId,
        paymentId: payment.id,
        payload: {
          lesson: await lessonSnapshot(tx, lessonId),
          amount_cents: priceCents,
          currency: lesson.currency,
          due_date: payment.due_date,
          invoice_number: payment.invoice_number,
          pay_url: payUrl(payment.pay_token),
          price_updated: true,
        },
        dedupeKey: `payment_request:${payment.id}:${priceCents}`,
      });
    }
  }

  await audit(tx, p, "lesson.price_changed", "lesson", lessonId, {
    before_cents: lesson.price_cents,
    after_cents: priceCents,
    reason: reason ?? null,
    payment_id: payment?.id ?? null,
  });
  return { changed: true as const, billed: Boolean(payment) };
}

export const priceListSchema = z.object({
  defaultPriceCents: cents,
  typePrices: z.record(z.enum(["practical", "exam_prep", "exam", "assessment"]), cents.nullable()),
  applyToUpcoming: z.boolean().default(false),
});

export async function savePriceList(tx: Tx, p: Principal, raw: z.input<typeof priceListSchema>) {
  assertPricing(p);
  const input = priceListSchema.parse(raw);
  const typePrices = Object.fromEntries(Object.entries(input.typePrices).filter(([, v]) => v !== null && v !== undefined));
  await tx.query(`UPDATE school_settings SET default_lesson_price_cents = $2, lesson_type_prices = $3 WHERE school_id = $1`, [
    p.schoolId,
    input.defaultPriceCents,
    JSON.stringify(typePrices),
  ]);

  let updated = 0;
  if (input.applyToUpcoming) {
    const ctx = await loadSchoolContext(tx, p.schoolId);
    const upcoming = await many<{ id: string; start_time: Date; end_time: Date; lesson_type: LessonType; price_cents: number }>(
      tx,
      `SELECT id, start_time, end_time, lesson_type, price_cents FROM lessons
        WHERE status IN ('scheduled','confirmed') AND start_time > now() AND NOT price_overridden AND payment_status = 'not_required'
        FOR UPDATE`,
    );
    for (const l of upcoming) {
      const minutes = Math.round((l.end_time.getTime() - l.start_time.getTime()) / 60000);
      const price = priceForDuration(ctx, minutes, l.lesson_type);
      if (price !== l.price_cents) {
        await tx.query(`UPDATE lessons SET price_cents = $2 WHERE id = $1`, [l.id, price]);
        updated++;
      }
    }
  }
  await audit(tx, p, "pricing.updated", "school", p.schoolId, { default_cents: input.defaultPriceCents, type_prices: typePrices, upcoming_updated: updated });
  return { updated };
}

export async function upcomingUnbilledCount(tx: Tx) {
  return (await one<{ n: number }>(
    tx,
    `SELECT count(*)::int AS n FROM lessons WHERE status IN ('scheduled','confirmed') AND start_time > now() AND NOT price_overridden AND payment_status = 'not_required'`,
  ))!.n;
}

export async function lessonPriceHistory(tx: Tx, lessonId: string) {
  return many<{ created_at: Date; changes: { before_cents: number; after_cents: number; reason: string | null } }>(
    tx,
    `SELECT created_at, changes FROM audit_logs WHERE entity_type = 'lesson' AND entity_id = $1 AND action = 'lesson.price_changed' ORDER BY created_at DESC LIMIT 5`,
    [lessonId],
  );
}
