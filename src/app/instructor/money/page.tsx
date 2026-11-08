import Link from "next/link";
import { many, withTenant } from "@/lib/db";
import { Flash, StatusBadge, sp, type SearchParams } from "@/components/ui";
import { getI18n } from "@/i18n/server";
import { ValidationError } from "@/lib/errors";
import { isManualMethod, MANUAL_METHODS } from "@/lib/payment-methods";
import { requireSchoolActor, requireSchoolPage } from "@/server/auth/session";
import { userPrincipal } from "@/server/principal";
import { recordManualPayment } from "@/server/services/billing";
import { parseRange, revenueSummary } from "@/server/services/reports";
import { schoolI18n } from "@/server/school";
import { runAction, str } from "@/server/web";

async function markPaid(fd: FormData) {
  "use server";
  const { t } = await getI18n();
  await runAction(async () => {
    const actor = await requireSchoolActor("payments:record_manual");
    const method = str(fd, "method");
    if (!isManualMethod(method)) throw new ValidationError(t("instructor.solo.chooseMethod"));
    await withTenant(actor.schoolId, (tx) => recordManualPayment(tx, userPrincipal(actor), str(fd, "paymentId"), "", method));
  }, { back: "/instructor/money", okMessage: t("instructor.solo.markedPaid") });
}

/** "Money" tab of the one-person-school app: what came in, what is still open, one tap to mark cash / PIN / bank as paid. */
export default async function MoneyPage({ searchParams }: { searchParams: SearchParams }) {
  const q = await sp(searchParams);
  const actor = await requireSchoolPage("payments:record_manual");
  const { school, t, f } = await schoolI18n(actor.schoolId);
  const { month, open } = await withTenant(actor.schoolId, async (tx) => ({
    month: await revenueSummary(tx, parseRange(undefined, undefined, school.timezone)),
    open: await many<{ id: string; student_id: string; student: string; amount_cents: number; currency: string; status: string; due_date: string; lesson_number: number | null; reference: string }>(
      tx,
      `SELECT p.id, p.student_id, s.first_name || ' ' || s.last_name AS student, p.amount_cents, p.currency, p.status, p.due_date, l.lesson_number, p.reference
         FROM payments p JOIN students s ON s.id = p.student_id LEFT JOIN lessons l ON l.id = p.lesson_id
        WHERE p.status IN ('pending','overdue','failed')
        ORDER BY p.status = 'overdue' DESC, p.due_date, p.id LIMIT 100`,
    ),
  }));
  const money = (c: number) => f.money(c, school.currency);
  const methodLabel = (m: string) => t(`pay.methods.${m}` as never);
  return (
    <>
      <h1>{t("instructor.tabs.money")}</h1>
      <Flash searchParams={q} />
      <dl className="mini-stats" style={{ marginTop: 0 }}>
        <div><dt>{t("instructor.solo.receivedMonth")}</dt><dd className="num">{money(month.net_cents)}</dd></div>
        <div><dt>{t("instructor.solo.open")}</dt><dd className="num">{money(month.open_cents)}</dd></div>
        <div><dt>{t("instructor.solo.overdue")}</dt><dd className="num">{money(month.overdue_cents)}</dd></div>
      </dl>
      <section className="card">
        <h2>{t("instructor.solo.toBePaid")}</h2>
        {open.length === 0 && <p className="muted">{t("student.allPaid")}</p>}
        {open.map((p) => (
          <div key={p.id} className="list-row" style={{ flexWrap: "wrap" }}>
            <div style={{ flex: 1, minWidth: 160 }}>
              <Link href={`/students/${p.student_id}`}><strong>{p.student}</strong></Link> <StatusBadge value={p.status} t={t} />
              <div className="sub">{p.lesson_number ? t("common.lessonNo", { number: p.lesson_number }) : <span dir="ltr">{p.reference}</span>} · {t("common.due")} {f.isoDate(p.due_date)}</div>
            </div>
            <strong className="num">{money(p.amount_cents)}</strong>
            <form action={markPaid} className="row" style={{ flexWrap: "nowrap" }}>
              <input type="hidden" name="paymentId" value={p.id} />
              <select name="method" defaultValue="cash" aria-label={t("instructor.solo.paidWith")} style={{ minHeight: 36, width: "auto" }}>
                {MANUAL_METHODS.map((m) => <option key={m} value={m}>{methodLabel(m)}</option>)}
              </select>
              <button className="sm primary">{t("instructor.solo.markPaid")}</button>
            </form>
          </div>
        ))}
      </section>
      <section className="card">
        <Link className="list-row" href="/admin/billing">{t("instructor.solo.paymentSettings")} <span className="flip">›</span></Link>
        <Link className="list-row" href="/admin/billing#packages">{t("instructor.solo.packages")} <span className="flip">›</span></Link>
        <Link className="list-row" href="/admin/payments?status=all">{t("instructor.solo.allPayments")} <span className="flip">›</span></Link>
        <a className="list-row" href="/api/reports/payments">{t("instructor.solo.accountantCsv")} <span>↓</span></a>
      </section>
    </>
  );
}
