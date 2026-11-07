import Link from "next/link";
import { redirect } from "next/navigation";
import { Logo } from "@/components/brand";
import { isLocale, translator } from "@/i18n";
import { getLocale } from "@/i18n/server";
import { resolvePayLink } from "@/server/payments/checkout";

export const dynamic = "force-dynamic";
export const metadata = { title: "Payment" };

/**
 * Stable link from e-mails: creates a fresh provider checkout and sends the
 * student there. When that isn't possible, explains why in the student's own
 * language (the one saved on their student record, else the browser's).
 */
export default async function PayPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const r = await resolvePayLink(token);
  if (r.kind === "redirect") redirect(r.url);
  const locale = "locale" in r && isLocale(r.locale) ? r.locale : await getLocale();
  const t = translator(locale);
  const offline = r.kind === "offline" || r.kind === "unavailable" ? r : null;
  const howToPay = offline && (offline.methods.length > 0 || offline.iban) ? (
    <div className="card" style={{ textAlign: "start" }}>
      <p>{t("pay.offlineIntro", { school: offline.schoolName })}</p>
      <ul>
        {offline.iban && <li>{t("pay.bankTransfer", { iban: offline.iban, school: offline.schoolName, reference: offline.reference })}</li>}
        {offline.methods.includes("cash") && <li>{t("pay.payCash")}</li>}
        {offline.methods.includes("pin") && <li>{t("pay.payPin")}</li>}
      </ul>
      {offline.note && <p className="small muted">{offline.note}</p>}
      {!offline.iban && <p className="small muted">{t("pay.quoteReference", { reference: offline.reference })}</p>}
    </div>
  ) : null;
  const message =
    r.kind === "already_paid"
      ? t("pay.alreadyPaid", { school: r.schoolName })
      : r.kind === "not_payable"
        ? t("pay.notPayable", { status: t(`status.${r.status}` as never) })
        : r.kind === "unavailable"
          ? `${t("pay.unavailable")}${howToPay ? "" : ` ${t("pay.contactSchool", { school: r.schoolName })}`}`
          : r.kind === "offline"
            ? howToPay ? null : t("pay.contactSchool", { school: r.schoolName })
            : t("pay.notFound");
  return (
    <main className="container narrow empty-page" lang={locale} dir={locale === "ar" ? "rtl" : "ltr"}>
      <Logo size={28} />
      <h1>{r.kind === "already_paid" ? t("pay.thanksTitle") : t("pay.title")}</h1>
      {message && <p className={r.kind === "already_paid" ? "flash ok" : "flash"}>{message}</p>}
      {howToPay}
      <Link className="btn primary" href="/">{t("pay.toDashboard")}</Link>
    </main>
  );
}
