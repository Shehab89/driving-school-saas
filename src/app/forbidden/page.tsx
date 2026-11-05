import Link from "next/link";
import { Logo } from "@/components/brand";
import { getI18n } from "@/i18n/server";

export default async function Forbidden() {
  const { t } = await getI18n();
  return (
    <main className="container narrow empty-page">
      <Logo size={28} />
      <div className="empty-page-code" aria-hidden>403</div>
      <h1>{t("common.forbiddenTitle")}</h1>
      <p className="muted">{t("common.forbiddenText")}</p>
      <Link className="btn primary" href="/">{t("common.goDashboard")}</Link>
    </main>
  );
}
