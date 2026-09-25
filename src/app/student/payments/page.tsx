import { StatusBadge } from "@/components/ui";
import { loadStudent } from "../data";

export default async function StudentPayments() {
  const { d, t, f } = await loadStudent();
  const open = d.payments.filter((p) => ["pending", "overdue", "failed"].includes(p.status));
  return (
    <>
      <h1>{t("student.paymentsTitle")}</h1>
      <section className="card">
        <div className="spread" style={{ marginBottom: 8 }}>
          <strong>{open.length ? t("student.openPayments", { count: open.length, amount: f.money(open.reduce((a, p) => a + p.amount_cents, 0), d.currency) }) : t("student.allPaid")}</strong>
        </div>
        {d.payments.length === 0 && <p className="muted">{t("student.noPayments")}</p>}
        {d.payments.map((p) => {
          const payable = ["pending", "overdue", "failed"].includes(p.status);
          return (
            <div key={p.id} className="list-row">
              <div>
                <strong className="num">{f.money(p.amount_cents, p.currency)}</strong>{" "}
                <StatusBadge value={p.status} t={t} />
                <div className="sub">
                  {p.lesson_number ? `${t("common.lessonNo", { number: p.lesson_number })} · ${f.shortDate(p.lesson_start!)}` : p.reference}
                  {" · "}
                  {p.paid_at ? t("student.paidOn", { date: f.shortDate(p.paid_at) }) : `${t("common.due")} ${f.isoDate(p.due_date)}`}
                </div>
              </div>
              {payable && <a className="btn primary" href={`/pay/${p.pay_token}`}>{t("student.payNow")}</a>}
            </div>
          );
        })}
      </section>
      <p className="muted small">{t("student.payNote")}</p>
    </>
  );
}
