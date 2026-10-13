import Link from "next/link";
import { withTenant } from "@/lib/db";
import { NotFoundError } from "@/lib/errors";
import { formatDate, formatMoney } from "@/lib/time";
import { formatVatRate } from "@/lib/vat";
import { requireSchoolPage } from "@/server/auth/session";
import { getInvoiceForViewer } from "@/server/services/invoices";

export const metadata = { title: "Invoice" };

/**
 * Printable invoice with the fields a Dutch invoice needs (school name and
 * address, KvK and VAT numbers, sequential invoice number, dates, VAT rate and
 * amount). Students see their own invoices, staff all of the school's.
 */
export default async function InvoicePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const actor = await requireSchoolPage();
  const inv = await withTenant(actor.schoolId, (tx) => getInvoiceForViewer(tx, actor, id)).catch((e) => {
    if (e instanceof NotFoundError) return null;
    throw e;
  });
  if (!inv) return <main className="container"><p>Invoice not found.</p></main>;
  const { school: s } = inv;
  const money = (c: number) => formatMoney(c, inv.currency, s.locale);
  const date = (d: Date | string) => formatDate(d, s.timezone, s.locale);
  const back = actor.role === "student" ? "/student/payments" : "/admin/payments";
  const payable = inv.payment && ["pending", "overdue", "failed"].includes(inv.payment.status) && inv.status !== "void";

  return (
    <main className="container invoice" style={{ maxWidth: 760 }}>
      <p className="no-print"><Link href={back}>← Back</Link> · <span className="muted small">Use your browser&apos;s print function to save as PDF.</span></p>
      <article className="card">
        <div className="spread" style={{ alignItems: "flex-start" }}>
          <div>
            <h1 style={{ marginBottom: 4 }}>{s.name}</h1>
            {s.address && <div style={{ whiteSpace: "pre-line" }}>{s.address}</div>}
            {s.email && <div>{s.email}</div>}
            {s.phone && <div>{s.phone}</div>}
            {s.coc && <div className="small">KvK: {s.coc}</div>}
            {s.vat_number && <div className="small">BTW-id / VAT: {s.vat_number}</div>}
          </div>
          <div style={{ textAlign: "end" }}>
            <h2 style={{ marginBottom: 4 }}>Invoice / Factuur</h2>
            <div><strong>{inv.invoice_number}</strong></div>
            <div className="small">Date: {date(inv.issued_at)}</div>
            <div className="small">Due: {date(`${inv.due_date}T12:00:00Z`)}</div>
            {inv.status === "void" && <div className="badge danger" style={{ marginTop: 6 }}>CANCELLED</div>}
          </div>
        </div>
        <hr />
        <div>
          <div className="small muted">Billed to</div>
          <div>{inv.student.name} ({inv.student.student_number})</div>
          {inv.student.email && <div className="small">{inv.student.email}</div>}
        </div>
        <table style={{ marginTop: 16 }}>
          <thead><tr><th>Description</th><th style={{ textAlign: "end" }}>Qty</th><th style={{ textAlign: "end" }}>Unit</th><th style={{ textAlign: "end" }}>Amount</th></tr></thead>
          <tbody>
            {inv.items.map((it, i) => (
              <tr key={i}>
                <td>{it.description}</td>
                <td style={{ textAlign: "end" }}>{it.quantity}</td>
                <td style={{ textAlign: "end" }}>{money(it.unit_cents)}</td>
                <td style={{ textAlign: "end" }}>{money(it.amount_cents)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <dl className="kv" style={{ marginTop: 16, marginInlineStart: "auto", maxWidth: 320 }}>
          <dt>Subtotal (excl. VAT)</dt><dd style={{ textAlign: "end" }}>{money(inv.subtotal_cents)}</dd>
          <dt>VAT {formatVatRate(inv.vat_rate_bps)}</dt><dd style={{ textAlign: "end" }}>{money(inv.tax_cents)}</dd>
          <dt><strong>Total</strong></dt><dd style={{ textAlign: "end" }}><strong>{money(inv.total_cents)}</strong></dd>
        </dl>
        {inv.vat_rate_bps === 0 && s.vat_exemption_note && <p className="small">{s.vat_exemption_note}</p>}
        {inv.vat_rate_bps > 0
          ? <p className="small muted">Item prices are shown {inv.prices_include_vat ? "including" : "excluding"} VAT.</p>
          : !s.vat_exemption_note && <p className="small muted">No VAT was charged on this invoice.</p>}
        {inv.status === "void" && inv.void_reason && <p className="small">This invoice was cancelled: {inv.void_reason}</p>}
        {inv.paid_at && <p><strong>Paid on {date(inv.paid_at)}.</strong></p>}
        {inv.payment?.status === "refunded" && <p><strong>This payment has been refunded.</strong></p>}
        {!inv.paid_at && inv.status !== "void" && s.iban && (
          <p className="small">Pay by bank transfer to {s.iban} in the name of {s.name}, quoting {inv.invoice_number}{payable ? ", or pay online with the button below." : "."}</p>
        )}
        {payable && <p className="no-print"><a className="btn primary" href={`/pay/${inv.payment!.pay_token}`}>Pay online</a></p>}
      </article>
    </main>
  );
}
