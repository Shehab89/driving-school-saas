/**
 * Files for bookkeeping software (Moneybird, e-Boekhouden, Exact, SnelStart,
 * or the accountant's Excel): the sales journal (verkoopboek) with one line
 * per invoice, and the customer list (relaties). These are import files, not
 * a live connection: no accounting login is needed or stored.
 */
import { DateTime } from "luxon";
import { many, one, type Tx } from "@/lib/db";
import type { Range } from "./reports";

export interface JournalRow {
  invoice_date: string;
  invoice_number: string;
  customer_number: string;
  customer_name: string;
  description: string;
  net_cents: number;
  vat_rate_bps: number;
  vat_cents: number;
  gross_cents: number;
  currency: string;
  status: string;
  paid_date: string | null;
  method: string | null;
}

/** Invoices issued in the period, in invoice-number order (draft invoices left out). Void invoices stay in with 0, so the numbering has no gaps. */
export async function salesJournal(tx: Tx, r: Range): Promise<JournalRow[]> {
  const start = DateTime.fromISO(r.from, { zone: r.timezone }).startOf("day").toJSDate();
  const end = DateTime.fromISO(r.to, { zone: r.timezone }).plus({ days: 1 }).startOf("day").toJSDate();
  return many<JournalRow>(
    tx,
    `SELECT to_char(i.issued_at AT TIME ZONE $3, 'YYYY-MM-DD') AS invoice_date, i.invoice_number, s.student_number AS customer_number,
            COALESCE(i.bill_to_name, '') AS customer_name,
            CASE WHEN i.status = 'void' THEN 'Void: ' || COALESCE(i.void_reason, '')
                 ELSE COALESCE((SELECT string_agg(it.description, '; ' ORDER BY it.id) FROM invoice_items it WHERE it.invoice_id = i.id), '') END AS description,
            CASE WHEN i.status = 'void' THEN 0 ELSE i.subtotal_cents END AS net_cents, i.vat_rate_bps,
            CASE WHEN i.status = 'void' THEN 0 ELSE i.tax_cents END AS vat_cents,
            CASE WHEN i.status = 'void' THEN 0 ELSE i.total_cents END AS gross_cents,
            i.currency, i.status,
            to_char(i.paid_at AT TIME ZONE $3, 'YYYY-MM-DD') AS paid_date,
            (SELECT COALESCE(p.method, p.provider) FROM payments p WHERE p.invoice_id = i.id AND p.paid_at IS NOT NULL ORDER BY p.paid_at DESC LIMIT 1) AS method
       FROM invoices i JOIN students s ON s.id = i.student_id
      WHERE i.status <> 'draft' AND i.issued_at >= $1 AND i.issued_at < $2
      ORDER BY i.invoice_number`,
    [start, end, r.timezone],
  );
}

/** Students who got an invoice in the period: the "relaties" to create in the bookkeeping program first. */
export async function journalCustomers(tx: Tx, r: Range) {
  const start = DateTime.fromISO(r.from, { zone: r.timezone }).startOf("day").toJSDate();
  const end = DateTime.fromISO(r.to, { zone: r.timezone }).plus({ days: 1 }).startOf("day").toJSDate();
  return many<{ customer_number: string; name: string; email: string | null; phone: string | null; address: string | null }>(
    tx,
    `SELECT s.student_number AS customer_number, trim(s.first_name || ' ' || s.last_name) AS name, s.email::text AS email, s.phone,
            s.pickup_address AS address
       FROM students s
      WHERE EXISTS (SELECT 1 FROM invoices i WHERE i.student_id = s.id AND i.status <> 'draft' AND i.issued_at >= $1 AND i.issued_at < $2)
      ORDER BY s.student_number`,
    [start, end],
  );
}

export async function revenueAccount(tx: Tx): Promise<string> {
  return (await one<{ a: string }>(tx, `SELECT revenue_account AS a FROM school_settings`))?.a ?? "8000";
}

export type JournalFormat = "nl" | "en";

/**
 * Dutch spreadsheet style (what Moneybird, e-Boekhouden and Excel in the
 * Netherlands expect): semicolons, decimal comma, Dutch column names, and a
 * byte-order mark so Excel reads é and ë correctly. "en" is plain CSV.
 */
export function journalCsv(rows: JournalRow[], account: string, format: JournalFormat): string {
  const nl = format === "nl";
  const amount = (c: number) => (nl ? (c / 100).toFixed(2).replace(".", ",") : (c / 100).toFixed(2));
  const pct = (bps: number) => (nl ? String(bps / 100).replace(".", ",") : String(bps / 100));
  const header = nl
    ? ["Factuurdatum", "Factuurnummer", "Relatiecode", "Relatie", "Omschrijving", "Bedrag excl. btw", "Btw-percentage", "Btw-bedrag", "Bedrag incl. btw", "Valuta", "Grootboekrekening", "Status", "Betaaldatum", "Betaalwijze"]
    : ["invoice_date", "invoice_number", "customer_number", "customer_name", "description", "net", "vat_rate", "vat", "gross", "currency", "revenue_account", "status", "paid_date", "payment_method"];
  return csv(header, rows.map((r) => [
    r.invoice_date, r.invoice_number, r.customer_number, r.customer_name, r.description,
    amount(r.net_cents), pct(r.vat_rate_bps), amount(r.vat_cents), amount(r.gross_cents), r.currency, account,
    nl ? STATUS_NL[r.status] ?? r.status : r.status, r.paid_date, r.method,
  ]), nl ? ";" : ",", nl);
}

export function customersCsv(rows: Awaited<ReturnType<typeof journalCustomers>>, format: JournalFormat): string {
  const nl = format === "nl";
  const header = nl ? ["Relatiecode", "Naam", "E-mail", "Telefoon", "Adres"] : ["customer_number", "name", "email", "phone", "address"];
  return csv(header, rows.map((r) => [r.customer_number, r.name, r.email, r.phone, r.address]), nl ? ";" : ",", nl);
}

const STATUS_NL: Record<string, string> = { open: "open", paid: "betaald", overdue: "te laat", void: "vervallen", refunded: "terugbetaald" };

/** RFC 4180 with a chosen separator; cells starting with = + - @ are prefixed so spreadsheets don't run them. */
function csv(header: string[], rows: Array<Array<string | number | null>>, sep: string, bom: boolean): string {
  const cell = (v: string | number | null) => {
    if (v === null || v === undefined) return "";
    let s = String(v);
    if (typeof v === "string" && /^[=+\-@\t\r]/.test(s) && !/^-?\d+([.,]\d+)?$/.test(s)) s = `'${s}`;
    return s.includes(sep) || /["\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return (bom ? "﻿" : "") + [header, ...rows].map((r) => r.map(cell).join(sep)).join("\r\n") + "\r\n";
}
