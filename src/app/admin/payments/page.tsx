import Link from "next/link";
import { many, withTenant } from "@/lib/db";
import { can } from "@/lib/rbac";
import { StatusBadge, Flash, PAGE_SIZE, Pager, pageParam, sp, type SearchParams } from "@/components/ui";
import { requireSchoolActor, requireSchoolPage } from "@/server/auth/session";
import { userPrincipal } from "@/server/principal";
import { recordManualPayment, refundPayment, voidInvoice } from "@/server/services/billing";
import { runAction, str } from "@/server/web";
import { getPt } from "@/i18n/server";
import { ptKey } from "@/i18n/portal";
import { schoolI18n } from "@/server/school";

const FILTERS = ["open", "paid", "refund_due", "disputed", "all"] as const;
const FILTER_LABELS: Record<(typeof FILTERS)[number], string> = {
  open: ptKey("Still to be paid"),
  paid: ptKey("Paid"),
  refund_due: ptKey("To refund"),
  disputed: ptKey("Disputed"),
  all: ptKey("All"),
};

async function markPaid(fd: FormData) {
  "use server";
  const pt = await getPt();
  await runAction(async () => {
    const actor = await requireSchoolActor("payments:record_manual");
    await withTenant(actor.schoolId, (tx) => recordManualPayment(tx, userPrincipal(actor), str(fd, "paymentId"), str(fd, "note") || pt("cash / bank transfer")));
  }, { back: `/admin/payments?status=${str(fd, "status")}`, okMessage: pt("Payment recorded") });
}

async function voidAction(fd: FormData) {
  "use server";
  const pt = await getPt();
  await runAction(async () => {
    const actor = await requireSchoolActor("payments:record_manual");
    await withTenant(actor.schoolId, (tx) => voidInvoice(tx, userPrincipal(actor), str(fd, "invoiceId"), str(fd, "reason")));
  }, { back: `/admin/payments?status=${str(fd, "status")}`, okMessage: pt("Invoice cancelled") });
}

async function refundAction(fd: FormData) {
  "use server";
  const pt = await getPt();
  let result = "";
  await runAction(async () => {
    const actor = await requireSchoolActor("payments:refund");
    result = await withTenant(actor.schoolId, (tx) => refundPayment(tx, userPrincipal(actor), str(fd, "paymentId"), str(fd, "reason")));
  }, {
    back: `/admin/payments?status=${str(fd, "status")}`,
    okMessage: () => (result === "refunded" ? pt("Marked as refunded") : pt("Refund sent to the payment provider. It shows as refunded once the provider confirms it.")),
  });
}

export default async function PaymentsPage({ searchParams }: { searchParams: SearchParams }) {
  const q = await sp(searchParams);
  const actor = await requireSchoolPage("payments:read_all");
  const { school, t, f, pt } = await schoolI18n(actor.schoolId);
  const canRefund = can(actor.role, "payments:refund");
  const status = (FILTERS as readonly string[]).includes(q.status ?? "") ? (q.status as (typeof FILTERS)[number]) : "open";
  const page = pageParam(q.page);
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
        ORDER BY p.status = 'disputed' DESC, p.status = 'overdue' DESC, p.due_date DESC, p.id LIMIT $2 OFFSET $3`,
      [status, PAGE_SIZE + 1, (page - 1) * PAGE_SIZE],
    ),
  );
  const money = (c: number, cur: string) => f.money(c, cur);
  return (
    <>
      <div className="page-title">
        <div>
          <h1>{pt("Payments")}</h1>
          <p>{pt("Online payments are marked paid automatically. Use “Mark paid” for cash or bank transfers.")}</p>
        </div>
        <div className="actions"><a className="btn" href="/api/reports/payments">{pt("Download (CSV)")}</a></div>
      </div>
      <Flash searchParams={q} />
      <div className="seg seg-scroll" style={{ marginBottom: 12 }}>
        {FILTERS.map((s) => <Link key={s} href={`/admin/payments?status=${s}`} className={s === status ? "active" : ""}>{pt(FILTER_LABELS[s])}</Link>)}
      </div>
      <div className="card table-card">
        {rows.length === 0 ? <p className="empty">{status === "open" ? pt("Everything is paid. Nice!") : pt("Nothing here.")}</p> : (
        <div className="table-wrap">
        <table className="stack-table">
          <thead><tr><th>{pt("Student")}</th><th>{pt("For")}</th><th>{pt("Amount")}</th><th>{pt("Due")}</th><th>{pt("Status")}</th><th>{pt("Actions")}</th></tr></thead>
          <tbody>
            {rows.slice(0, PAGE_SIZE).map((p) => (
              <tr key={p.id}>
                <td data-label={pt("Student")}><Link href={`/students/${p.student_id}`}><strong>{p.student}</strong></Link></td>
                <td data-label={pt("For")} className="small">
                  {p.lesson_number ? pt("Lesson {number}", { number: p.lesson_number }) : ""} <span className="muted" dir="ltr">{p.reference}</span>
                  {p.lesson_status === "cancelled" && <div className="muted">{pt("Lesson cancelled")}</div>}
                  {p.invoice_id && <div><Link href={`/invoices/${p.invoice_id}`}>{pt("Invoice")}</Link></div>}
                </td>
                <td data-label={pt("Amount")} className="num"><strong>{money(p.amount_cents, p.currency)}</strong></td>
                <td data-label={pt("Due")} className="small">{f.isoDate(p.due_date)}</td>
                <td data-label={pt("Status")}>
                  <StatusBadge value={p.status} t={t} />
                  {p.paid_at && <div className="small muted">{f.dateTime(p.paid_at)} · {p.recorded ? pt("by hand") : p.provider}</div>}
                  {p.refund_requested_at && p.status === "paid" && <div className="small muted">{pt("Refund requested {date}, waiting for the provider", { date: f.dateTime(p.refund_requested_at) })}</div>}
                  {p.refund_reason && p.status === "refunded" && <div className="small muted">{p.refund_reason}</div>}
                </td>
                <td data-label={pt("Actions")}>
                  {["pending", "overdue", "failed"].includes(p.status) && (
                    <>
                      <form action={markPaid} className="row">
                        <input type="hidden" name="paymentId" value={p.id} />
                        <input type="hidden" name="status" value={status} />
                        <input name="note" placeholder={pt("cash / bank")} style={{ width: 120, minHeight: 34 }} aria-label={pt("Note")} />
                        <button className="sm primary">{pt("Mark paid")}</button>
                      </form>
                      {p.invoice_id && (
                        <details className="small inline-more">
                          <summary>{pt("Cancel invoice")}</summary>
                          <form action={voidAction} className="row">
                            <input type="hidden" name="invoiceId" value={p.invoice_id} />
                            <input type="hidden" name="status" value={status} />
                            <input name="reason" required placeholder={pt("Reason")} style={{ width: 160, minHeight: 34 }} aria-label={pt("Reason")} />
                            <button className="danger sm">{pt("Cancel invoice")}</button>
                          </form>
                        </details>
                      )}
                    </>
                  )}
                  {canRefund && p.status === "paid" && !p.refund_requested_at && (
                    <details className="small inline-more">
                      <summary>{pt("Refund")}</summary>
                      <form action={refundAction} className="row">
                        <input type="hidden" name="paymentId" value={p.id} />
                        <input type="hidden" name="status" value={status} />
                        <input name="reason" required placeholder={pt("Reason")} style={{ width: 160, minHeight: 34 }} aria-label={pt("Reason")} />
                        <button className="danger sm">{pt("Refund {amount}", { amount: money(p.amount_cents, p.currency) })}</button>
                      </form>
                    </details>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        </div>
        )}
        <div style={{ padding: "0 18px 14px" }}>
          <Pager pt={pt} page={page} hasNext={rows.length > PAGE_SIZE} href={(n) => `/admin/payments?status=${status}&page=${n}`} />
          <details className="small muted">
            <summary>{pt("How payments work")}</summary>
            <p>{pt("Online payments are marked paid automatically by the payment provider. “Mark paid” is for cash or bank transfers and is recorded in the audit log.")}</p>
            <p>{pt("Refunds of online payments go back through the provider and show as refunded once it confirms. A disputed payment is a chargeback opened by the student's bank; respond to it in your payment provider's dashboard.")}</p>
          </details>
        </div>
      </div>
    </>
  );
}
