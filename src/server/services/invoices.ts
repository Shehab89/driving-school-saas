/**
 * Read model for a printable invoice. Staff with payments:read_all see any
 * invoice of their school; a student sees only their own. Everything else gets
 * NotFound, so invoice ids cannot be probed.
 */
import { many, one, type Tx } from "@/lib/db";
import { NotFoundError } from "@/lib/errors";
import { can } from "@/lib/rbac";
import type { SchoolActor } from "@/lib/rbac";

export interface InvoiceView {
  id: string;
  invoice_number: string;
  status: string;
  issued_at: Date;
  due_date: string;
  paid_at: Date | null;
  subtotal_cents: number;
  tax_cents: number;
  total_cents: number;
  currency: string;
  vat_rate_bps: number;
  prices_include_vat: boolean;
  void_reason: string | null;
  student: { id: string; name: string; student_number: string; email: string | null };
  school: { name: string; address: string | null; email: string | null; phone: string | null; timezone: string; locale: string; vat_number: string | null; coc: string | null; iban: string | null; vat_exemption_note: string | null };
  items: { description: string; quantity: number; unit_cents: number; amount_cents: number }[];
  payment: { status: string; pay_token: string; refund_requested_at: Date | null } | null;
}

export async function getInvoiceForViewer(tx: Tx, actor: SchoolActor, invoiceId: string): Promise<InvoiceView> {
  const staff = can(actor.role, "payments:read_all");
  if (!staff && !(actor.role === "student" && actor.studentId)) throw new NotFoundError("Invoice");
  type Row = Omit<InvoiceView, "student" | "school" | "items" | "payment"> & {
    student_id: string; student_name: string; student_number: string; student_email: string | null;
    school_name: string; address: string | null; school_email: string | null; phone: string | null; timezone: string; locale: string;
    vat_number: string | null; coc: string | null; iban: string | null; vat_exemption_note: string | null;
  };
  const inv = await one<Row>(
    tx,
    `SELECT i.id, i.invoice_number, i.status, i.issued_at, i.due_date::text AS due_date, i.paid_at, i.subtotal_cents, i.tax_cents, i.total_cents,
            i.currency, i.vat_rate_bps, i.prices_include_vat, i.void_reason, i.student_id,
            st.first_name || ' ' || st.last_name AS student_name, st.student_number, st.email AS student_email,
            sc.name AS school_name, sc.address, sc.email AS school_email, sc.phone, sc.timezone, sc.locale,
            ss.vat_number, ss.chamber_of_commerce_number AS coc, ss.iban, ss.vat_exemption_note
       FROM invoices i JOIN students st ON st.id = i.student_id JOIN schools sc ON sc.id = i.school_id
       LEFT JOIN school_settings ss ON ss.school_id = i.school_id
      WHERE i.id = $1 AND ($2::uuid IS NULL OR i.student_id = $2)`,
    [invoiceId, staff ? null : actor.studentId],
  );
  if (!inv) throw new NotFoundError("Invoice");
  const items = await many<InvoiceView["items"][number]>(
    tx,
    `SELECT description, quantity, unit_cents, amount_cents FROM invoice_items WHERE invoice_id = $1 ORDER BY kind, description`,
    [invoiceId],
  );
  const payment = await one<NonNullable<InvoiceView["payment"]>>(
    tx,
    `SELECT status, pay_token, refund_requested_at FROM payments WHERE invoice_id = $1 ORDER BY created_at DESC LIMIT 1`,
    [invoiceId],
  );
  const r = inv;
  return {
    id: inv.id, invoice_number: inv.invoice_number, status: inv.status, issued_at: inv.issued_at, due_date: inv.due_date, paid_at: inv.paid_at,
    subtotal_cents: inv.subtotal_cents, tax_cents: inv.tax_cents, total_cents: inv.total_cents, currency: inv.currency,
    vat_rate_bps: inv.vat_rate_bps, prices_include_vat: inv.prices_include_vat, void_reason: inv.void_reason,
    student: { id: r.student_id, name: r.student_name, student_number: r.student_number, email: r.student_email },
    school: { name: r.school_name, address: r.address, email: r.school_email, phone: r.phone, timezone: r.timezone, locale: r.locale, vat_number: r.vat_number, coc: r.coc, iban: r.iban, vat_exemption_note: r.vat_exemption_note },
    items,
    payment,
  };
}
