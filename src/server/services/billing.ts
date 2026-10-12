import { DateTime } from "luxon";
import { many, one, type Tx } from "@/lib/db";
import { env } from "@/lib/env";
import { ConflictError, ForbiddenError, NotFoundError, PolicyError, ValidationError } from "@/lib/errors";
import { can } from "@/lib/rbac";
import type { Principal } from "../principal";
import type { SchoolSchedulingContext } from "../scheduling/loader";
import { lessonSnapshot, type LessonRow } from "./lessons";
import { audit } from "./audit";
import { enqueueNotification } from "./notifications";
import { splitVat } from "@/lib/vat";
import { getPaymentProvider } from "../payments";
import { log } from "@/lib/log";

export interface PaymentRow {
  id: string;
  school_id: string;
  invoice_id: string;
  student_id: string;
  lesson_id: string | null;
  amount_cents: number;
  currency: string;
  provider: string;
  status: "pending" | "paid" | "overdue" | "failed" | "cancelled" | "refunded" | "disputed";
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

/**
 * Recalculate an invoice's net/VAT from its lines (using the VAT rate frozen on
 * the invoice) and make its open payment match the gross total. Returns gross.
 */
export async function recomputeInvoice(tx: Tx, invoiceId: string): Promise<number> {
  const inv = (await one<{ items_cents: number; vat_rate_bps: number; prices_include_vat: boolean }>(
    tx,
    `SELECT COALESCE((SELECT sum(amount_cents) FROM invoice_items WHERE invoice_id = i.id), 0)::int AS items_cents, i.vat_rate_bps, i.prices_include_vat
       FROM invoices i WHERE i.id = $1`,
    [invoiceId],
  ))!;
  const v = splitVat(inv.items_cents, inv.vat_rate_bps, inv.prices_include_vat);
  await tx.query(`UPDATE invoices SET subtotal_cents = $2, tax_cents = $3 WHERE id = $1`, [invoiceId, v.netCents, v.vatCents]);
  return v.grossCents;
}

export type InvoiceKind = "lesson" | "cancellation_fee" | "package";

export async function createInvoiceWithPayment(
  tx: Tx,
  p: Principal,
  ctx: SchoolSchedulingContext,
  args: { studentId: string; lessonId: string | null; kind: InvoiceKind; description: string; amountCents: number; dueDate?: string },
) {
  const year = DateTime.now().setZone(ctx.timezone).year;
  const seq = await nextCounter(tx, p.schoolId, `invoice:${year}`);
  const invoiceNumber = `${year}-${String(seq).padStart(5, "0")}`;
  const dueDate = args.dueDate ?? DateTime.now().setZone(ctx.timezone).plus({ days: ctx.settings.payment_due_days }).toISODate()!;

  const invoice = (await one<{ id: string }>(
    tx,
    `INSERT INTO invoices (school_id, student_id, invoice_number, status, subtotal_cents, currency, due_date, vat_rate_bps, prices_include_vat)
     VALUES ($1,$2,$3,'open',0,$4,$5,$6,$7) RETURNING id`,
    [p.schoolId, args.studentId, invoiceNumber, ctx.currency, dueDate, ctx.settings.vat_rate_bps, ctx.settings.prices_include_vat],
  ))!;
  await tx.query(
    `INSERT INTO invoice_items (school_id, invoice_id, lesson_id, kind, description, unit_cents)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [p.schoolId, invoice.id, args.lessonId, args.kind, args.description, args.amountCents],
  );
  const gross = await recomputeInvoice(tx, invoice.id);
  const payment = (await one<PaymentRow>(
    tx,
    `INSERT INTO payments (school_id, invoice_id, student_id, lesson_id, amount_cents, currency, provider, status, reference, due_date)
     VALUES ($1,$2,$3,$4,$5,$6,$7,'pending',$8,$9) RETURNING *`,
    [p.schoolId, invoice.id, args.studentId, args.lessonId, gross, ctx.currency, env.paymentProvider, `INV ${invoiceNumber}`, dueDate],
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
  await creditPackageIfPaid(tx, p, payment.invoice_id);
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
  kind: "succeeded" | "failed" | "refunded" | "disputed" | "dispute_won" | "dispute_lost" | "ignored";
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
    // A failed attempt never marks anything paid; the student can retry with the same link.
    if (["pending", "overdue"].includes(payment.status)) {
      await tx.query(`UPDATE payments SET status = 'failed' WHERE id = $1`, [payment.id]);
      await notifyStudent(tx, p, payment, "payment_failed", { pay_url: payUrl(payment.pay_token) });
    }
    await audit(tx, p, "payment.failed", "payment", payment.id, { event: ev.eventId });
  } else if (ev.kind === "refunded") {
    if (["paid", "disputed"].includes(payment.status)) {
      await markRefunded(tx, p, payment);
      await notifyStudent(tx, p, payment, "payment_refunded", {});
    }
    await audit(tx, p, "payment.refunded", "payment", payment.id, { event: ev.eventId });
  } else if (ev.kind === "disputed") {
    if (payment.status === "paid") {
      await tx.query(`UPDATE payments SET status = 'disputed' WHERE id = $1`, [payment.id]);
      if (payment.lesson_id) await tx.query(`UPDATE lessons SET payment_status = 'disputed' WHERE id = $1`, [payment.lesson_id]);
      await notifyOwners(tx, p, payment, "payment_disputed");
    }
    await audit(tx, p, "payment.disputed", "payment", payment.id, { event: ev.eventId, amount_cents: ev.amountCents });
  } else if (ev.kind === "dispute_won") {
    if (payment.status === "disputed") {
      await tx.query(`UPDATE payments SET status = 'paid' WHERE id = $1`, [payment.id]);
      if (payment.lesson_id) await tx.query(`UPDATE lessons SET payment_status = 'paid' WHERE id = $1`, [payment.lesson_id]);
    }
    await audit(tx, p, "payment.dispute_won", "payment", payment.id, { event: ev.eventId });
  } else if (ev.kind === "dispute_lost") {
    // The card holder's bank took the money back: treat as refunded.
    if (["disputed", "paid"].includes(payment.status)) await markRefunded(tx, p, payment);
    await audit(tx, p, "payment.dispute_lost", "payment", payment.id, { event: ev.eventId });
  }
  await tx.query(`UPDATE payment_provider_events SET processed_at = now() WHERE id = $1`, [inserted.id]);
  return { applied: true as const };
}

async function notifyStudent(tx: Tx, p: Principal, payment: PaymentRow, type: "payment_failed" | "payment_refunded", extra: Record<string, unknown>) {
  const student = await one<{ email: string | null; first_name: string }>(tx, `SELECT email, first_name FROM students WHERE id = $1`, [payment.student_id]);
  await enqueueNotification(tx, {
    schoolId: p.schoolId,
    type,
    to: student?.email,
    studentId: payment.student_id,
    paymentId: payment.id,
    payload: { name: student?.first_name, amount_cents: payment.amount_cents, currency: payment.currency, reference: payment.reference, ...extra },
    dedupeKey: `${type}:${payment.id}:${Date.now() - (Date.now() % 3_600_000)}`,
  });
}

async function notifyOwners(tx: Tx, p: Principal, payment: PaymentRow, type: "payment_disputed") {
  const owners = await many<{ id: string; email: string }>(tx, `SELECT id, email FROM users WHERE role IN ('school_owner') AND status = 'active'`);
  for (const o of owners) {
    await enqueueNotification(tx, {
      schoolId: p.schoolId,
      type,
      to: o.email,
      userId: o.id,
      paymentId: payment.id,
      payload: { amount_cents: payment.amount_cents, currency: payment.currency, reference: payment.reference },
      dedupeKey: `${type}:${payment.id}:${o.id}`,
    });
  }
}

/** Shared by provider refunds, lost disputes and manual refunds. */
async function markRefunded(tx: Tx, p: Principal, payment: PaymentRow) {
  await tx.query(`UPDATE payments SET status = 'refunded', refunded_at = now() WHERE id = $1`, [payment.id]);
  await tx.query(`UPDATE invoices SET status = 'refunded' WHERE id = $1`, [payment.invoice_id]);
  if (payment.lesson_id) await tx.query(`UPDATE lessons SET payment_status = 'refunded' WHERE id = $1`, [payment.lesson_id]);
  // A refunded package takes its credits back (the balance may go negative if lessons were already used).
  const purchase = await one<{ id: string; student_id: string; lesson_count: number; status: string }>(
    tx,
    `SELECT id, student_id, lesson_count, status FROM package_purchases WHERE invoice_id = $1 FOR UPDATE`,
    [payment.invoice_id],
  );
  if (purchase) {
    if (purchase.status === "credited") {
      await tx.query(
        `INSERT INTO student_credit_ledger (school_id, student_id, delta, reason, purchase_id) VALUES ($1,$2,$3,'refund',$4)
         ON CONFLICT (purchase_id, reason) WHERE purchase_id IS NOT NULL DO NOTHING`,
        [p.schoolId, purchase.student_id, -purchase.lesson_count, purchase.id],
      );
    }
    await tx.query(`UPDATE package_purchases SET status = 'refunded' WHERE id = $1`, [purchase.id]);
  }
}

// ---------------------------------------------------------------------------
// Payment models
// ---------------------------------------------------------------------------

/** Pay in advance: invoice at booking time, due no later than the lesson day. */
export async function createBookingInvoice(tx: Tx, p: Principal, ctx: SchoolSchedulingContext, lesson: LessonRow) {
  const lessonDay = DateTime.fromJSDate(lesson.start_time, { zone: ctx.timezone }).toISODate()!;
  const normalDue = DateTime.now().setZone(ctx.timezone).plus({ days: ctx.settings.payment_due_days }).toISODate()!;
  const { payment, invoiceNumber } = await createInvoiceWithPayment(tx, p, ctx, {
    studentId: lesson.student_id,
    lessonId: lesson.id,
    kind: "lesson",
    description: `Driving lesson – ${DateTime.fromJSDate(lesson.start_time, { zone: ctx.timezone }).toFormat("d LLL yyyy HH:mm")}`,
    amountCents: lesson.price_cents,
    dueDate: lessonDay < normalDue ? lessonDay : normalDue,
  });
  await tx.query(`UPDATE lessons SET payment_status = 'pending' WHERE id = $1`, [lesson.id]);
  const student = await one<{ email: string | null }>(tx, `SELECT email FROM students WHERE id = $1`, [lesson.student_id]);
  await enqueueNotification(tx, {
    schoolId: p.schoolId,
    type: "booking_payment_request",
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
  await audit(tx, p, "payment.requested", "payment", payment.id, { lesson_id: lesson.id, amount_cents: payment.amount_cents, mode: "at_booking" });
  return payment;
}

/** Credit balance and how much of it is already spoken for by upcoming lessons. */
export async function creditSummary(tx: Tx, studentId: string) {
  return (await one<{ balance: number; upcoming: number }>(
    tx,
    `SELECT COALESCE((SELECT sum(delta) FROM student_credit_ledger WHERE student_id = $1), 0)::int AS balance,
            (SELECT count(*)::int FROM lessons WHERE student_id = $1 AND status IN ('scheduled','confirmed','in_progress') AND payment_status = 'not_required') AS upcoming`,
    [studentId],
  ))!;
}

/**
 * Credits mode: a completed (or no-show) lesson uses one credit when the
 * student has one; returns false when there is no credit, so the caller bills
 * the lesson normally instead.
 */
export async function consumeCreditForLesson(tx: Tx, p: Principal, lesson: LessonRow): Promise<boolean> {
  // Serialise per student so two completions can't spend the same last credit.
  await tx.query(`SELECT 1 FROM students WHERE id = $1 FOR UPDATE`, [lesson.student_id]);
  const { balance } = await creditSummary(tx, lesson.student_id);
  if (balance <= 0) return false;
  const r = await tx.query(
    `INSERT INTO student_credit_ledger (school_id, student_id, delta, reason, lesson_id, created_by) VALUES ($1,$2,-1,'lesson',$3,$4)
     ON CONFLICT (lesson_id, reason) WHERE lesson_id IS NOT NULL DO NOTHING`,
    [p.schoolId, lesson.student_id, lesson.id, p.type === "user" ? p.actor.userId : null],
  );
  await tx.query(`UPDATE lessons SET payment_status = 'prepaid' WHERE id = $1`, [lesson.id]);
  if (r.rowCount) await audit(tx, p, "credit.used", "lesson", lesson.id, { balance_after: balance - 1 });
  return true;
}

/** Grant the credits of a package purchase once its invoice is fully paid (idempotent). */
async function creditPackageIfPaid(tx: Tx, p: Principal, invoiceId: string) {
  const purchase = await one<{ id: string; student_id: string; lesson_count: number }>(
    tx,
    `SELECT pp.id, pp.student_id, pp.lesson_count FROM package_purchases pp JOIN invoices i ON i.id = pp.invoice_id
      WHERE pp.invoice_id = $1 AND pp.status = 'awaiting_payment' AND i.status = 'paid' FOR UPDATE OF pp`,
    [invoiceId],
  );
  if (!purchase) return;
  await tx.query(
    `INSERT INTO student_credit_ledger (school_id, student_id, delta, reason, purchase_id) VALUES ($1,$2,$3,'purchase',$4)
     ON CONFLICT (purchase_id, reason) WHERE purchase_id IS NOT NULL DO NOTHING`,
    [p.schoolId, purchase.student_id, purchase.lesson_count, purchase.id],
  );
  await tx.query(`UPDATE package_purchases SET status = 'credited', credited_at = now() WHERE id = $1`, [purchase.id]);
  await audit(tx, p, "credit.purchased", "package_purchase", purchase.id, { lessons: purchase.lesson_count });
}

// ---------------------------------------------------------------------------
// Corrections (audited)
// ---------------------------------------------------------------------------

/**
 * Cancel an unpaid invoice (wrong amount, goodwill, lesson cancelled). Paid
 * invoices cannot be voided: refund them instead, so the money trail stays complete.
 */
export async function voidInvoice(tx: Tx, p: Principal, invoiceId: string, reason: string) {
  if (p.type === "user" && !can(p.actor.role, "payments:record_manual")) throw new ForbiddenError();
  if (!reason.trim()) throw new ValidationError("A reason is required.");
  const inv = await one<{ id: string; status: string }>(tx, `SELECT id, status FROM invoices WHERE id = $1 FOR UPDATE`, [invoiceId]);
  if (!inv) throw new NotFoundError("Invoice");
  if (inv.status === "void") return;
  const paid = await one(tx, `SELECT 1 FROM payments WHERE invoice_id = $1 AND status IN ('paid','refunded','disputed')`, [invoiceId]);
  if (paid) throw new PolicyError("This invoice has been paid. Refund the payment instead of voiding it.", "invoice_paid");
  await tx.query(`UPDATE payments SET status = 'cancelled', payment_link = NULL, provider_checkout_id = NULL WHERE invoice_id = $1 AND status IN ('pending','overdue','failed')`, [invoiceId]);
  await tx.query(`UPDATE invoices SET status = 'void', void_reason = $2, voided_at = now() WHERE id = $1`, [invoiceId, reason.trim()]);
  await tx.query(
    `UPDATE lessons SET payment_status = 'not_required'
      WHERE id IN (SELECT lesson_id FROM invoice_items WHERE invoice_id = $1 AND kind = 'lesson' AND lesson_id IS NOT NULL)`,
    [invoiceId],
  );
  await tx.query(`UPDATE package_purchases SET status = 'cancelled' WHERE invoice_id = $1 AND status = 'awaiting_payment'`, [invoiceId]);
  await audit(tx, p, "invoice.voided", "invoice", invoiceId, { reason: reason.trim() });
}

/**
 * Refund a paid payment (owner only). Card/iDEAL payments are refunded through
 * the provider and only marked refunded when its signed webhook confirms it;
 * cash/bank payments are marked refunded immediately on the owner's word.
 */
export async function refundPayment(tx: Tx, p: Principal, paymentId: string, reason: string): Promise<"requested" | "refunded"> {
  if (p.type !== "user" || !can(p.actor.role, "payments:refund")) throw new ForbiddenError();
  if (!reason.trim()) throw new ValidationError("A reason is required.");
  const payment = await one<PaymentRow & { connected_account: string | null; recorded_by: string | null }>(
    tx,
    `SELECT pay.*, spa.provider_account_id AS connected_account
       FROM payments pay LEFT JOIN school_payment_accounts spa ON spa.school_id = pay.school_id AND spa.provider = pay.provider AND spa.status = 'active'
      WHERE pay.id = $1 FOR UPDATE OF pay`,
    [paymentId],
  );
  if (!payment) throw new NotFoundError("Payment");
  if (payment.status !== "paid") throw new PolicyError("Only paid payments can be refunded.", "invalid_status");
  await tx.query(`UPDATE payments SET refund_requested_at = now(), refund_reason = $2 WHERE id = $1`, [paymentId, reason.trim()]);

  if (!payment.provider_payment_id || payment.recorded_by) {
    // Paid in cash / by bank transfer and recorded by staff: the refund is also outside the provider.
    await markRefunded(tx, p, payment);
    await audit(tx, p, "payment.refunded_manually", "payment", paymentId, { reason: reason.trim(), amount_cents: payment.amount_cents });
    return "refunded";
  }
  const provider = getPaymentProvider(payment.provider);
  const r = await provider.refund({
    providerPaymentId: payment.provider_payment_id,
    amountCents: payment.amount_cents,
    connectedAccountId: payment.connected_account,
    idempotencyKey: `refund:${paymentId}`,
    reason: reason.trim(),
  });
  log.info("payment.refund_requested", { paymentId, refundId: r.refundId });
  await audit(tx, p, "payment.refund_requested", "payment", paymentId, { reason: reason.trim(), refund_id: r.refundId, amount_cents: payment.amount_cents });
  return "requested";
}

/** Owner/admin correction of a student's credit balance, with a mandatory note. */
export async function adjustCredits(tx: Tx, p: Principal, studentId: string, delta: number, note: string) {
  if (p.type !== "user" || !can(p.actor.role, "payments:record_manual")) throw new ForbiddenError();
  if (!Number.isInteger(delta) || delta === 0 || Math.abs(delta) > 100) throw new ValidationError("Enter a whole number of lessons between -100 and 100.");
  if (!note.trim()) throw new ValidationError("A note is required.");
  const s = await one(tx, `SELECT 1 FROM students WHERE id = $1 FOR UPDATE`, [studentId]);
  if (!s) throw new NotFoundError("Student");
  await tx.query(
    `INSERT INTO student_credit_ledger (school_id, student_id, delta, reason, note, created_by) VALUES ($1,$2,$3,'adjustment',$4,$5)`,
    [p.schoolId, studentId, delta, note.trim(), p.actor.userId],
  );
  await audit(tx, p, "credit.adjusted", "student", studentId, { delta, note: note.trim() });
}

/**
 * When a pay-in-advance lesson is cancelled: an unpaid invoice is voided; a
 * paid one stays paid and is flagged so staff can refund or keep it as agreed.
 */
export async function settleCancelledLessonBilling(tx: Tx, p: Principal, lessonId: string) {
  const item = await one<{ invoice_id: string; payment_status: string | null }>(
    tx,
    `SELECT ii.invoice_id, (SELECT status FROM payments WHERE invoice_id = ii.invoice_id ORDER BY created_at DESC LIMIT 1) AS payment_status
       FROM invoice_items ii JOIN invoices i ON i.id = ii.invoice_id
      WHERE ii.lesson_id = $1 AND ii.kind = 'lesson' AND i.status <> 'void'`,
    [lessonId],
  );
  if (!item) return;
  if (["pending", "overdue", "failed"].includes(item.payment_status ?? "")) {
    await voidInvoice(tx, { type: "system", schoolId: p.schoolId }, item.invoice_id, "Lesson cancelled before it took place");
  } else if (item.payment_status === "paid") {
    await audit(tx, p, "payment.refund_due", "lesson", lessonId, { invoice_id: item.invoice_id });
  }
}

/** A rescheduled lesson keeps its invoice and payment: they move to the replacement lesson. */
export async function moveLessonBilling(tx: Tx, fromLessonId: string, toLessonId: string) {
  await tx.query(`UPDATE invoice_items SET lesson_id = $2 WHERE lesson_id = $1 AND kind = 'lesson'`, [fromLessonId, toLessonId]);
  await tx.query(`UPDATE payments SET lesson_id = $2 WHERE lesson_id = $1`, [fromLessonId, toLessonId]);
  await tx.query(
    `UPDATE lessons SET payment_status = (SELECT payment_status FROM lessons WHERE id = $1) WHERE id = $2`,
    [fromLessonId, toLessonId],
  );
}
