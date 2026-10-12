/**
 * Lesson packages (prepaid credits). A school sells "10 lessons for €520";
 * buying one creates a normal invoice and payment, and the credits are added
 * to the student's ledger only when that payment is confirmed (verified
 * webhook or staff recording cash). Lessons use one credit each when they are
 * completed (see consumeCreditForLesson).
 */
import { z } from "zod";
import { many, one, type Tx } from "@/lib/db";
import { ForbiddenError, NotFoundError, PolicyError } from "@/lib/errors";
import { can } from "@/lib/rbac";
import type { Principal } from "../principal";
import { loadSchoolContext } from "../scheduling/loader";
import { audit } from "./audit";
import { createInvoiceWithPayment, creditSummary, payUrl } from "./billing";
import { enqueueNotification } from "./notifications";

export interface LessonPackage {
  id: string;
  name: string;
  description: string | null;
  lesson_count: number;
  price_cents: number;
  currency: string;
  sold_online: boolean;
  is_active: boolean;
}

const packageSchema = z.object({
  name: z.string().trim().min(1).max(100),
  description: z.string().trim().max(500).optional(),
  lessonCount: z.coerce.number().int().min(1).max(200),
  priceCents: z.coerce.number().int().min(1).max(10_000_000),
  soldOnline: z.boolean().default(true),
});

export async function createPackage(tx: Tx, p: Principal, raw: z.input<typeof packageSchema>) {
  if (p.type !== "user" || !can(p.actor.role, "pricing:write")) throw new ForbiddenError();
  const i = packageSchema.parse(raw);
  const ctx = await loadSchoolContext(tx, p.schoolId);
  const row = (await one<{ id: string }>(
    tx,
    `INSERT INTO lesson_packages (school_id, name, description, lesson_count, price_cents, currency, sold_online) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
    [p.schoolId, i.name, i.description ?? null, i.lessonCount, i.priceCents, ctx.currency, i.soldOnline],
  ))!;
  await audit(tx, p, "package.created", "lesson_package", row.id, { ...i });
  return row;
}

/** Packages are never deleted (purchases refer to them); they are switched off instead. */
export async function setPackageActive(tx: Tx, p: Principal, packageId: string, active: boolean) {
  if (p.type !== "user" || !can(p.actor.role, "pricing:write")) throw new ForbiddenError();
  const r = await tx.query(`UPDATE lesson_packages SET is_active = $2 WHERE id = $1`, [packageId, active]);
  if (!r.rowCount) throw new NotFoundError("Package");
  await audit(tx, p, active ? "package.activated" : "package.deactivated", "lesson_package", packageId);
}

export async function listPackages(tx: Tx, opts: { onlineOnly?: boolean; includeInactive?: boolean } = {}) {
  return many<LessonPackage>(
    tx,
    `SELECT id, name, description, lesson_count, price_cents, currency, sold_online, is_active FROM lesson_packages
      WHERE ($1 OR is_active) AND (NOT $2 OR sold_online) ORDER BY is_active DESC, lesson_count`,
    [opts.includeInactive ?? false, opts.onlineOnly ?? false],
  );
}

/** Staff sell a package to a student, or a student buys one online. Returns the stable pay link. */
export async function purchasePackage(tx: Tx, p: Principal, args: { studentId: string; packageId: string }) {
  const selfService = p.type === "user" && p.actor.role === "student";
  if (p.type === "user") {
    if (selfService && p.actor.studentId !== args.studentId) throw new ForbiddenError();
    if (!selfService && !can(p.actor.role, "payments:record_manual")) throw new ForbiddenError();
  } else if (p.type !== "system") throw new ForbiddenError();

  const pkg = await one<LessonPackage>(tx, `SELECT * FROM lesson_packages WHERE id = $1 AND is_active`, [args.packageId]);
  if (!pkg) throw new NotFoundError("Package");
  if (selfService && !pkg.sold_online) throw new PolicyError("This package is only sold at the school.", "package_not_online");
  const student = await one<{ id: string; email: string | null; first_name: string; status: string }>(
    tx,
    `SELECT id, email, first_name, status FROM students WHERE id = $1 FOR UPDATE`,
    [args.studentId],
  );
  if (!student) throw new NotFoundError("Student");
  if (!["active", "lead", "paused"].includes(student.status)) throw new PolicyError("This student cannot buy lessons.", "student_inactive");
  // One unpaid package at a time keeps double clicks from creating several invoices.
  const open = await one<{ pay_token: string; payment_id: string }>(
    tx,
    `SELECT pay.pay_token, pay.id AS payment_id FROM package_purchases pp JOIN payments pay ON pay.invoice_id = pp.invoice_id
      WHERE pp.student_id = $1 AND pp.package_id = $2 AND pp.status = 'awaiting_payment' AND pay.status IN ('pending','overdue','failed')`,
    [args.studentId, args.packageId],
  );
  if (open) return { paymentId: open.payment_id, payUrl: payUrl(open.pay_token), reused: true };

  const ctx = await loadSchoolContext(tx, p.schoolId);
  const { payment, invoiceId, invoiceNumber } = await createInvoiceWithPayment(tx, p, ctx, {
    studentId: args.studentId,
    lessonId: null,
    kind: "package",
    description: `${pkg.name} (${pkg.lesson_count} lessons)`,
    amountCents: pkg.price_cents,
  });
  const purchase = (await one<{ id: string }>(
    tx,
    `INSERT INTO package_purchases (school_id, student_id, package_id, invoice_id, lesson_count, created_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
    [p.schoolId, args.studentId, pkg.id, invoiceId, pkg.lesson_count, p.type === "user" ? p.actor.userId : null],
  ))!;
  await enqueueNotification(tx, {
    schoolId: p.schoolId,
    type: "package_payment_request",
    to: student.email,
    studentId: student.id,
    paymentId: payment.id,
    payload: {
      name: student.first_name,
      package_name: pkg.name,
      lesson_count: pkg.lesson_count,
      amount_cents: payment.amount_cents,
      currency: payment.currency,
      invoice_number: invoiceNumber,
      pay_url: payUrl(payment.pay_token),
    },
    dedupeKey: `payment_request:${payment.id}`,
  });
  await audit(tx, p, "package.purchased", "package_purchase", purchase.id, { package_id: pkg.id, payment_id: payment.id });
  return { paymentId: payment.id, payUrl: payUrl(payment.pay_token), reused: false };
}

/** Balance, what is reserved by upcoming lessons, and the ledger history. */
export async function studentCredits(tx: Tx, studentId: string) {
  const summary = await creditSummary(tx, studentId);
  const ledger = await many<{ created_at: Date; delta: number; reason: string; note: string | null; lesson_number: number | null }>(
    tx,
    `SELECT c.created_at, c.delta, c.reason, c.note, l.lesson_number
       FROM student_credit_ledger c LEFT JOIN lessons l ON l.id = c.lesson_id
      WHERE c.student_id = $1 ORDER BY c.created_at DESC LIMIT 50`,
    [studentId],
  );
  return { ...summary, available: summary.balance - summary.upcoming, ledger };
}
