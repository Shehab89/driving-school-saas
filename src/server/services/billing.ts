import { DateTime } from "luxon";
import { one, type Tx } from "@/lib/db";
import { env } from "@/lib/env";
import { ConflictError, ForbiddenError, NotFoundError, PolicyError, ValidationError } from "@/lib/errors";
import { can } from "@/lib/rbac";
import type { Principal } from "../principal";
import type { SchoolSchedulingContext } from "../scheduling/loader";
import { lessonSnapshot, type LessonRow } from "./lessons";
import { audit } from "./audit";
import { enqueueNotification } from "./notifications";

export interface PaymentRow {
  id: string;
  school_id: string;
  invoice_id: string;
  student_id: string;
  lesson_id: string | null;
  amount_cents: number;
  currency: string;
  provider: string;
  status: "pending" | "paid" | "overdue" | "failed" | "cancelled" | "refunded";
  pay_token: string;
  payment_link: string | null;
  provider_checkout_id: string | null;
  provider_payment_id: string | null;
  reference: string;
  due_date: string;
  paid_at: Date | null;
}

export function payUrl(payToken: string) {
  return `${env.appUrl}/pay/${payToken}`;
}

async function nextCounter(tx: Tx, schoolId: string, name: string): Promise<number> {
  const r = await one<{ value: string }>(
    tx,
    `INSERT INTO school_counters (school_id, name, value) VALUES ($1, $2, 1)
     ON CONFLICT (school_id, name) DO UPDATE SET value = school_counters.value + 1
     RETURNING value`,
    [schoolId, name],
  );
  return Number(r!.value);
}

export async function nextStudentNumber(tx: Tx, schoolId: string) {
  return `S-${String(await nextCounter(tx, schoolId, "student")).padStart(4, "0")}`;
}

async function createInvoiceWithPayment(
  tx: Tx,
  p: Principal,
  ctx: SchoolSchedulingContext,
  args: { studentId: string; lessonId: string | null; kind: "lesson" | "cancellation_fee"; description: string; amountCents: number },
) {
  const year = DateTime.now().setZone(ctx.timezone).year;
  const seq = await nextCounter(tx, p.schoolId, `invoice:${year}`);
  const invoiceNumber = `${year}-${String(seq).padStart(5, "0")}`;
  const dueDate = DateTime.now().setZone(ctx.timezone).plus({ days: ctx.settings.payment_due_days }).toISODate()!;

  const invoice = (await one<{ id: string }>(
    tx,
    `INSERT INTO invoices (school_id, student_id, invoice_number, status, subtotal_cents, currency, due_date)
     VALUES ($1,$2,$3,'open',$4,$5,$6) RETURNING id`,
    [p.schoolId, args.studentId, invoiceNumber, args.amountCents, ctx.currency, dueDate],
  ))!;
  await tx.query(
    `INSERT INTO invoice_items (school_id, invoice_id, lesson_id, kind, description, unit_cents)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [p.schoolId, invoice.id, args.lessonId, args.kind, args.description, args.amountCents],
  );
  const payment = (await one<PaymentRow>(
    tx,
    `INSERT INTO payments (school_id, invoice_id, student_id, lesson_id, amount_cents, currency, provider, status, reference, due_date)
     VALUES ($1,$2,$3,$4,$5,$6,$7,'pending',$8,$9) RETURNING *`,
    [p.schoolId, invoice.id, args.studentId, args.lessonId, args.amountCents, ctx.currency, env.paymentProvider, `INV ${invoiceNumber}`, dueDate],
  ))!;
  return { invoiceId: invoice.id, invoiceNumber, payment };
}

/**
 * Called when a lesson is completed (or marked no-show). Idempotent per
 * lesson: the unique index on invoice_items(lesson_id, kind) prevents double
 * billing even if two requests race.
 */
export async function createInvoiceAndPaymentForLesson(tx: Tx, p: Principal, ctx: SchoolSchedulingContext, lesson: LessonRow) {
  const existing = await one<{ id: string }>(
    tx,
    `SELECT pay.id FROM invoice_items ii JOIN payments pay ON pay.invoice_id = ii.invoice_id
      WHERE ii.lesson_id = $1 AND ii.kind = 'lesson'`,
    [lesson.id],
  );
  if (existing) return existing;

  const { payment, invoiceNumber } = await createInvoiceWithPayment(tx, p, ctx, {
    studentId: lesson.student_id,
    lessonId: lesson.id,
    kind: "lesson",
    description: `Driving lesson #${lesson.lesson_number} – ${DateTime.fromJSDate(lesson.start_time, { zone: ctx.timezone }).toFormat("d LLL yyyy HH:mm")}`,
    amountCents: lesson.price_cents,
  });
  await tx.query(`UPDATE lessons SET payment_status = 'pending' WHERE id = $1`, [lesson.id]);

  const student = await one<{ email: string | null }>(tx, `SELECT email FROM students WHERE id = $1`, [lesson.student_id]);
  await enqueueNotification(tx, {
    schoolId: p.schoolId,
    type: "lesson_completed_payment_request",
    to: student?.email,
    studentId: lesson.student_id,
    lessonId: lesson.id,
    paymentId: payment.id,
    payload: {
      lesson: await lessonSnapshot(tx, lesson.id),
      amount_cents: payment.amount_cents,
      currency: payment.currency,
      due_date: payment.due_date,
      invoice_number: invoiceNumber,
      pay_url: payUrl(payment.pay_token),
    },
    dedupeKey: `payment_request:${payment.id}`,
  });
  await audit(tx, p, "payment.requested", "payment", payment.id, { lesson_id: lesson.id, amount_cents: payment.amount_cents });
  return payment;
}

export async function createCancellationFeeInvoice(tx: Tx, p: Principal, ctx: SchoolSchedulingContext, lesson: LessonRow) {
  const fee = ctx.settings.late_cancellation_fee_cents;
  const { payment, invoiceNumber } = await createInvoiceWithPayment(tx, p, ctx, {
    studentId: lesson.student_id,
    lessonId: lesson.id,
    kind: "cancellation_fee",
    description: `Late cancellation fee – lesson on ${DateTime.fromJSDate(lesson.start_time, { zone: ctx.timezone }).toFormat("d LLL yyyy HH:mm")}`,
    amountCents: fee,
  });
  const student = await one<{ email: string | null }>(tx, `SELECT email FROM students WHERE id = $1`, [lesson.student_id]);
  await enqueueNotification(tx, {
    schoolId: p.schoolId,
    type: "lesson_completed_payment_request",
    to: student?.email,
    studentId: lesson.student_id,
    lessonId: lesson.id,
    paymentId: payment.id,
    payload: { amount_cents: fee, currency: payment.currency, due_date: payment.due_date, invoice_number: invoiceNumber, pay_url: payUrl(payment.pay_token), is_cancellation_fee: true },
    dedupeKey: `payment_request:${payment.id}`,
  });
  await audit(tx, p, "payment.cancellation_fee", "payment", payment.id, { lesson_id: lesson.id });
  return payment;
}

/** Instructor/staff: bill a completed lesson that was completed without a payment request. */
export async function requestPaymentForLesson(tx: Tx, p: Principal, ctx: SchoolSchedulingContext, lessonId: string) {
  if (p.type !== "user" || !can(p.actor.role, "payments:request")) throw new ForbiddenError();
  const lesson = await one<LessonRow>(tx, `SELECT * FROM lessons WHERE id = $1 FOR UPDATE`, [lessonId]);
  if (!lesson) throw new NotFoundError("Lesson");
  if (p.actor.role === "instructor" && p.actor.instructorId !== lesson.instructor_id) throw new ForbiddenError();
  if (!["completed", "no_show"].includes(lesson.status)) throw new PolicyError("Only completed lessons can be billed.", "invalid_status");
  if (lesson.price_cents <= 0) throw new ValidationError("This lesson has no price.");
  return createInvoiceAndPaymentForLesson(tx, p, ctx, lesson);
}

// ---------------------------------------------------------------------------
// Settlement. Only two paths can mark a payment as paid:
//   1. a verified provider webhook (applyProviderEvent)
//   2. an owner/admin recording a cash/bank payment (recordManualPayment), audited
// Nothing the browser sends can do it.
// ---------------------------------------------------------------------------

async function settle(tx: Tx, p: Principal, payment: PaymentRow, extra: { providerPaymentId?: string | null }) {
  await tx.query(
    `UPDATE payments SET status = 'paid', paid_at = now(), provider_payment_id = COALESCE($2, provider_payment_id) WHERE id = $1`,
    [payment.id, extra.providerPaymentId ?? null],
  );
  await tx.query(
    `UPDATE invoices SET status = 'paid', paid_at = now()
      WHERE id = $1 AND NOT EXISTS (SELECT 1 FROM payments WHERE invoice_id = $1 AND status NOT IN ('paid','cancelled'))`,
    [payment.invoice_id],
  );
  if (payment.lesson_id) {
    await tx.query(
      `UPDATE lessons SET payment_status = 'paid'
        WHERE id = $1 AND NOT EXISTS (SELECT 1 FROM payments WHERE lesson_id = $1 AND status IN ('pending','overdue','failed'))`,
      [payment.lesson_id],
    );
  }
  const student = await one<{ email: string | null }>(tx, `SELECT email FROM students WHERE id = $1`, [payment.student_id]);
  await enqueueNotification(tx, {
    schoolId: p.schoolId,
    type: "payment_succeeded",
    to: student?.email,
    studentId: payment.student_id,
    lessonId: payment.lesson_id,
    paymentId: payment.id,
    payload: { amount_cents: payment.amount_cents, currency: payment.currency, reference: payment.reference },
    dedupeKey: `payment_succeeded:${payment.id}`,
  });
}

export async function recordManualPayment(tx: Tx, p: Principal, paymentId: string, note: string) {
  if (p.type !== "user" || !can(p.actor.role, "payments:record_manual")) throw new ForbiddenError();
  const payment = await one<PaymentRow>(tx, `SELECT * FROM payments WHERE id = $1 FOR UPDATE`, [paymentId]);
  if (!payment) throw new NotFoundError("Payment");
  if (payment.status === "paid") throw new ConflictError("This payment is already paid.", "already_paid");
  if (!["pending", "overdue", "failed"].includes(payment.status)) throw new PolicyError("This payment cannot be settled.", "invalid_status");
  await tx.query(`UPDATE payments SET recorded_by = $2 WHERE id = $1`, [paymentId, p.actor.userId]);
  await settle(tx, p, payment, {});
  await audit(tx, p, "payment.recorded_manually", "payment", paymentId, { note, amount_cents: payment.amount_cents });
}

/** Provider-neutral webhook event (see src/server/payments/types.ts). */
export interface NormalizedPaymentEvent {
  provider: string;
  eventId: string;
  eventType: string;
  kind: "succeeded" | "failed" | "refunded" | "ignored";
  paymentId: string | null;
  amountCents: number | null;
  currency: string | null;
  providerCheckoutId: string | null;
  providerPaymentId: string | null;
  raw: unknown;
}

/**
 * Apply a verified provider event exactly once. The (provider, event_id)
 * unique key makes retries no-ops; amount and currency are checked against
 * what we expect before anything is marked paid.
 */
export async function applyProviderEvent(tx: Tx, schoolId: string, ev: NormalizedPaymentEvent) {
  const p: Principal = { type: "webhook", schoolId, source: ev.provider };
  const inserted = await one<{ id: string }>(
    tx,
    `INSERT INTO payment_provider_events (school_id, provider, event_id, event_type, payment_id, payload)
     VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (provider, event_id) DO NOTHING RETURNING id`,
    [schoolId, ev.provider, ev.eventId, ev.eventType, ev.paymentId, JSON.stringify(ev.raw)],
  );
  if (!inserted) return { applied: false, reason: "duplicate" as const };
  if (ev.kind === "ignored") {
    await tx.query(`UPDATE payment_provider_events SET processed_at = now() WHERE id = $1`, [inserted.id]);
    return { applied: false, reason: "ignored" as const };
  }

  const payment = ev.paymentId
    ? await one<PaymentRow>(tx, `SELECT * FROM payments WHERE id = $1 FOR UPDATE`, [ev.paymentId])
    : await one<PaymentRow>(tx, `SELECT * FROM payments WHERE provider = $1 AND provider_payment_id = $2 FOR UPDATE`, [ev.provider, ev.providerPaymentId]);
  if (!payment) throw new NotFoundError("Payment for provider event");

  if (ev.kind === "succeeded") {
    if (ev.amountCents !== payment.amount_cents || ev.currency?.toUpperCase() !== payment.currency) {
      await tx.query(`UPDATE payment_provider_events SET error = 'amount_mismatch', processed_at = now() WHERE id = $1`, [inserted.id]);
      await audit(tx, p, "payment.amount_mismatch", "payment", payment.id, { expected: payment.amount_cents, got: ev.amountCents, currency: ev.currency });
      return { applied: false, reason: "amount_mismatch" as const };
    }
    if (payment.status !== "paid") {
      await settle(tx, p, payment, { providerPaymentId: ev.providerPaymentId });
      await audit(tx, p, "payment.succeeded", "payment", payment.id, { provider: ev.provider, event: ev.eventId });
    }
  } else if (ev.kind === "failed") {
    if (payment.status === "pending") await tx.query(`UPDATE payments SET status = 'failed' WHERE id = $1`, [payment.id]);
    await audit(tx, p, "payment.failed", "payment", payment.id, { event: ev.eventId });
  } else if (ev.kind === "refunded") {
    await tx.query(`UPDATE payments SET status = 'refunded', refunded_at = now() WHERE id = $1 AND status = 'paid'`, [payment.id]);
    await tx.query(`UPDATE invoices SET status = 'refunded' WHERE id = $1`, [payment.invoice_id]);
    if (payment.lesson_id) await tx.query(`UPDATE lessons SET payment_status = 'refunded' WHERE id = $1`, [payment.lesson_id]);
    await audit(tx, p, "payment.refunded", "payment", payment.id, { event: ev.eventId });
  }
  await tx.query(`UPDATE payment_provider_events SET processed_at = now() WHERE id = $1`, [inserted.id]);
  return { applied: true as const };
}
