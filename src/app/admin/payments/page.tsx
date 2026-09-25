import Link from "next/link";
import { many, withTenant } from "@/lib/db";
import { formatDate, formatDateTime, formatMoney } from "@/lib/time";
import { Badge, Flash, sp, type SearchParams } from "@/components/ui";
import { requireSchoolActor, requireSchoolPage } from "@/server/auth/session";
import { userPrincipal } from "@/server/principal";
import { recordManualPayment } from "@/server/services/billing";
import { schoolHeader } from "@/server/school";
import { runAction, str } from "@/server/web";

async function markPaid(fd: FormData) {
  "use server";
  await runAction(async () => {
    const actor = await requireSchoolActor("payments:record_manual");
    await withTenant(actor.schoolId, (tx) => recordManualPayment(tx, userPrincipal(actor), str(fd, "paymentId"), str(fd, "note") || "cash / bank transfer"));
  }, { back: `/admin/payments?status=${str(fd, "status")}`, okMessage: "Payment recorded" });
}

export default async function PaymentsPage({ searchParams }: { searchParams: SearchParams }) {
  const q = await sp(searchParams);
  const actor = await requireSchoolPage("payments:read_all");
  const school = await schoolHeader(actor.schoolId);
  const status = ["open", "paid", "all"].includes(q.status ?? "") ? q.status! : "open";
  const rows = await withTenant(actor.schoolId, (tx) =>
    many<{ id: string; student_id: string; student: string; amount_cents: number; currency: string; status: string; due_date: string; paid_at: Date | null; reference: string; provider: string; lesson_number: number | null }>(
      tx,
      `SELECT p.id, p.student_id, s.first_name || ' ' || s.last_name AS student, p.amount_cents, p.currency, p.status, p.due_date, p.paid_at, p.reference, p.provider, l.lesson_number
         FROM payments p JOIN students s ON s.id = p.student_id LEFT JOIN lessons l ON l.id = p.lesson_id
        WHERE ($1 = 'all' OR ($1 = 'open' AND p.status IN ('pending','overdue','failed')) OR ($1 = 'paid' AND p.status IN ('paid','refunded')))
        ORDER BY p.status = 'overdue' DESC, p.due_date DESC LIMIT 300`,
      [status],
    ),
  );
  return (
    <>
      <h1>Payments</h1>
      <Flash searchParams={q} />
      <div className="seg" style={{ marginBottom: 12 }}>
        {(["open", "paid", "all"] as const).map((s) => <Link key={s} href={`/admin/payments?status=${s}`} className={s === status ? "active" : ""}>{s}</Link>)}
      </div>
      <div className="card table-wrap">
        <table>
          <thead><tr><th>Student</th><th>For</th><th>Amount</th><th>Due</th><th>Status</th><th /></tr></thead>
          <tbody>
            {rows.map((p) => (
              <tr key={p.id}>
                <td><Link href={`/students/${p.student_id}`}>{p.student}</Link></td>
                <td className="small">{p.lesson_number ? `Lesson #${p.lesson_number}` : ""} {p.reference}</td>
                <td>{formatMoney(p.amount_cents, p.currency, school.locale)}</td>
                <td>{formatDate(`${p.due_date}T12:00:00Z`, school.timezone)}</td>
                <td><Badge value={p.status} />{p.paid_at && <div className="small muted">{formatDateTime(p.paid_at, school.timezone)} · {p.provider}</div>}</td>
                <td>
                  {["pending", "overdue", "failed"].includes(p.status) && (
                    <form action={markPaid} className="row">
                      <input type="hidden" name="paymentId" value={p.id} />
                      <input type="hidden" name="status" value={status} />
                      <input name="note" placeholder="cash / bank" style={{ width: 110, minHeight: 32 }} aria-label="Note" />
                      <button style={{ minHeight: 32 }}>Mark paid</button>
                    </form>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="small muted">Online payments are marked paid automatically by the payment provider&apos;s webhook. &quot;Mark paid&quot; is for cash or bank transfers and is recorded in the audit log.</p>
      </div>
    </>
  );
}
