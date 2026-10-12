import { withTenant } from "@/lib/db";
import { Flash, StatusBadge, sp, type SearchParams } from "@/components/ui";
import { requireSchoolActor } from "@/server/auth/session";
import { userPrincipal } from "@/server/principal";
import { listPackages, purchasePackage, studentCredits } from "@/server/services/packages";
import { runAction, str } from "@/server/web";
import { loadStudent } from "../data";

async function buyPackage(fd: FormData) {
  "use server";
  let payPath = "";
  await runAction(async () => {
    const actor = await requireSchoolActor("payments:read_own");
    const r = await withTenant(actor.schoolId, (tx) => purchasePackage(tx, userPrincipal(actor), { studentId: actor.studentId!, packageId: str(fd, "packageId") }));
    payPath = new URL(r.payUrl).pathname;
  }, { back: "/student/payments", success: () => payPath });
}

export default async function StudentPayments({ searchParams }: { searchParams: SearchParams }) {
  const q = await sp(searchParams);
  const { actor, d, t, f } = await loadStudent();
  const { credits, packages, mode } = await withTenant(actor.schoolId, async (tx) => {
    const m = await tx.query<{ payment_mode: string }>(`SELECT payment_mode FROM school_settings`);
    return {
      mode: m.rows[0]?.payment_mode ?? "after_lesson",
      credits: await studentCredits(tx, actor.studentId!),
      packages: await listPackages(tx, { onlineOnly: true }),
    };
  });
  const open = d.payments.filter((p) => ["pending", "overdue", "failed"].includes(p.status));
  const showCredits = mode === "credits" || credits.balance !== 0 || packages.length > 0;
  return (
    <>
      <h1>{t("student.paymentsTitle")}</h1>
      <Flash searchParams={q} />
      {showCredits && (
        <section className="card">
          <h2>{t("student.creditsTitle")}</h2>
          <p><strong>{t("student.creditsBalance", { count: Math.max(credits.available, 0) })}</strong></p>
          {credits.upcoming > 0 && <p className="small muted">{t("student.creditsReserved", { count: credits.upcoming })}</p>}
          {packages.length > 0 && (
            <>
              <h3>{t("student.packagesTitle")}</h3>
              {packages.map((p) => (
                <form key={p.id} action={buyPackage} className="list-row">
                  <div>
                    <strong>{p.name}</strong>
                    <div className="sub">{t("student.packageLessons", { count: p.lesson_count })} · {f.money(p.price_cents, p.currency)}</div>
                    {p.description && <div className="sub">{p.description}</div>}
                  </div>
                  <input type="hidden" name="packageId" value={p.id} />
                  <button className="primary">{t("student.buyPackage")}</button>
                </form>
              ))}
            </>
          )}
        </section>
      )}
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
                  {p.invoice_id && <> · <a href={`/invoices/${p.invoice_id}`}>{t("student.invoice")}</a></>}
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
