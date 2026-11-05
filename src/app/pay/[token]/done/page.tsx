import Link from "next/link";
import { Logo } from "@/components/brand";
import { getI18n } from "@/i18n/server";

/** Stripe success redirect. Deliberately does NOT mark anything paid: only the webhook does. */
export default async function PaymentDone() {
  const { t } = await getI18n();
  return (
    <main className="container narrow empty-page">
      <Logo size={28} />
      <div className="empty-page-code ok" aria-hidden>✓</div>
      <h1>{t("pay.thanksTitle")}</h1>
      <p className="muted">{t("pay.thanksText")}</p>
      <Link className="btn primary" href="/">{t("pay.toDashboard")}</Link>
    </main>
  );
}
