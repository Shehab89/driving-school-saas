import Link from "next/link";
import { many, withTenant } from "@/lib/db";
import { can } from "@/lib/rbac";
import { formatDate, formatDateTime, formatMoney } from "@/lib/time";
import { Badge, Flash, sp, type SearchParams } from "@/components/ui";
import { requireSchoolActor, requireSchoolPage } from "@/server/auth/session";
import { userPrincipal } from "@/server/principal";
import { recordManualPayment, refundPayment, voidInvoice } from "@/server/services/billing";
import { schoolHeader } from "@/server/school";
import { runAction, str } from "@/server/web";

const FILTERS = ["open", "paid", "refund_due", "disputed", "all"] as const;
const FILTER_LABELS: Record<(typeof FILTERS)[number], string> = {
  open: "Open",
  paid: "Paid",
  refund_due: "Refund due",
  disputed: "Disputed",
  all: "All",
};

async function markPaid(fd: FormData) {
  "use server";
  await runAction(async () => {
    const actor = await requireSchoolActor("payments:record_manual");
    await withTenant(actor.schoolId, (tx) => recordManualPayment(tx, userPrincipal(actor), str(fd, "paymentId"), str(fd, "note") || "cash / bank transfer"));
  }, { back: `/admin/payments?status=${str(fd, "status")}`, okMessage: "Payment recorded" });
}

async function voidAction(fd: FormData) {
  "use server";
  await runAction(async () => {
    const actor = await requireSchoolActor("payments:record_manual");
    await withTenant(actor.schoolId, (tx) => voidInvoice(tx, userPrincipal(actor), str(fd, "invoiceId"), str(fd, "reason")));
  }, { back: `/admin/payments?status=${str(fd, "status")}`, okMessage: "Invoice cancelled" });
}

async function refundAction(fd: FormData) {
  "use server";
  let result = "";
  await runAction(async () => {
    const actor = await requireSchoolActor("payments:refund");
    result = await withTenant(actor.schoolId, (tx) => refundPayment(tx, userPrincipal(actor), str(fd, "paymentId"), str(fd, "reason")));
  }, {
    back: `/admin/payments?status=${str(fd, "status")}`,
    okMessage: () => (result === "refunded" ? "Marked as refunded" : "Refund sent to the payment provider. It shows as refunded once the provider confirms it."),
  });
}

export default async function PaymentsPage({ searchParams }: { searchParams: SearchParams }) {
  const q = await sp(searchParams);
  const actor = await requireSchoolPage("payments:read_all");
  const school = await schoolHeader(actor.schoolId);
  const canRefund = can(actor.role, "payments:refund");
  const status = (FILTERS as readonly string[]).includes(q.status ?? "") ? (q.status as (typeof FILTERS)[number]) : "open";
  const rows = await withTenant(actor.schoolId, (tx) =>
    many<{
      id: string; invoice_id: string | null; student_id: string; student: string; amount_cents: number; currency: string; status: string;
      due_date: string; paid_at: Date | null; reference: string; provider: string; lesson_number: number | null; lesson_status: string | null;
      refund_requested_at: Date | null; refund_reason: string | null; recorded: boolean;
    }>(
      tx,
      `SELECT p.id, p.invoice_id, p.student_id, s.first_name || ' ' || s.last_name AS student, p.amount_cents, p.currency, p.status, p.due_date,
              p.paid_at, p.reference, p.provider, l.lesson_number, l.status AS lesson_status, p.refund_requested_at, p.refund_reason,
              p.recorded_by IS NOT NULL AS recorded
         FROM payments p JOIN students s ON s.id = p.student_id LEFT JOIN lessons l ON l.id = p.lesson_id
        WHERE $1 = 'all'
           OR ($1 = 'open' AND p.status IN ('pending','overdue','failed'))
           OR ($1 = 'paid' AND p.status IN ('paid','refunded'))
           OR ($1 = 'disputed' AND p.status = 'disputed')
           -- Paid in advance for a lesson that was then cancelled, and not refunded yet.
           OR ($1 = 'refund_due' AND p.status = 'paid' AND l.status = 'cancelled' AND p.refund_requested_at IS NULL)
        ORDER BY p.status = 'disputed' DESC, p.status = 'overdue' DESC, p.due_date DESC LIMIT 300`,
      [status],
    ),
  );
  return (
    <>
      <h1>Payments</h1>
      <Flash searchParams={q} />
      <div className="seg" style={{ marginBottom: 12 }}>
        {FILTERS.map((s) => <Link key={s} href={`/admin/payments?status=${s}`} className={s === status ? "active" : ""}>{FILTER_LABELS[s]}</Link>)}
      </div>
      <div className="card table-wrap">
        <table>
          <thead><tr><th>Student</th><th>For</th><th>Amount</th><th>Due</th><th>Status</th><th /></tr></thead>
          <tbody>
            {rows.length === 0 && <tr><td colSpan={6} className="muted">Nothing here.</td></tr>}
            {rows.map((p) => (
              <tr key={p.id}>
                <td><Link href={`/students/${p.student_id}`}>{p.student}</Link></td>
                <td className="small">
                  {p.lesson_number ? `Lesson #${p.lesson_number}` : ""} {p.reference}
                  {p.lesson_status === "cancelled" && <div className="muted">Lesson cancelled</div>}
                  {p.invoice_id && <div><Link href={`/invoices/${p.invoice_id}`}>Invoice</Link></div>}
                </td>
                <td>{formatMoney(p.amount_cents, p.currency, school.locale)}</td>
                <td>{formatDate(`${p.due_date}T12:00:00Z`, school.timezone)}</td>
                <td>
                  <Badge value={p.status} />
                  {p.paid_at && <div className="small muted">{formatDateTime(p.paid_at, school.timezone)} · {p.recorded ? "manual" : p.provider}</div>}
                  {p.refund_requested_at && p.status === "paid" && <div className="small muted">Refund requested {formatDateTime(p.refund_requested_at, school.timezone)}, waiting for the provider</div>}
                  {p.refund_reason && p.status === "refunded" && <div className="small muted">{p.refund_reason}</div>}
                </td>
                <td>
                  {["pending", "overdue", "failed"].includes(p.status) && (
                    <>
                      <form action={markPaid} className="row">
                        <input type="hidden" name="paymentId" value={p.id} />
                        <input type="hidden" name="status" value={status} />
                        <input name="note" placeholder="cash / bank" style={{ width: 110, minHeight: 32 }} aria-label="Note" />
                        <button style={{ minHeight: 32 }}>Mark paid</button>
                      </form>
                      {p.invoice_id && (
                        <details className="small">
                          <summary>Cancel invoice</summary>
                          <form action={voidAction} className="row">
                            <input type="hidden" name="invoiceId" value={p.invoice_id} />
                            <input type="hidden" name="status" value={status} />
                            <input name="reason" required placeholder="Reason" style={{ width: 160, minHeight: 32 }} aria-label="Reason" />
                            <button className="danger" style={{ minHeight: 32 }}>Cancel invoice</button>
                          </form>
                        </details>
                      )}
                    </>
                  )}
                  {canRefund && p.status === "paid" && !p.refund_requested_at && (
                    <details className="small">
                      <summary>Refund</summary>
                      <form action={refundAction} className="row">
                        <input type="hidden" name="paymentId" value={p.id} />
                        <input type="hidden" name="status" value={status} />
                        <input name="reason" required placeholder="Reason" style={{ width: 160, minHeight: 32 }} aria-label="Reason" />
                        <button className="danger" style={{ minHeight: 32 }}>Refund {formatMoney(p.amount_cents, p.currency, school.locale)}</button>
                      </form>
                    </details>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="small muted">
          Online payments are marked paid automatically by the payment provider&apos;s webhook. &quot;Mark paid&quot; is for cash or bank transfers and is recorded in the audit log.
          Refunds of online payments go back through the provider and show as refunded once it confirms. A disputed payment is a chargeback opened by the student&apos;s bank; respond to it in your payment provider&apos;s dashboard.
        </p>
      </div>
    </>
  );
}
