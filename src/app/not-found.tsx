import Link from "next/link";
import { Logo } from "@/components/brand";
import { getI18n } from "@/i18n/server";

/** Shown for unknown URLs and for ids that don't exist or belong to someone else (no "something went wrong"). */
export default async function NotFound() {
  const { t } = await getI18n();
  return (
    <main className="container narrow empty-page">
      <Logo size={28} />
      <div className="empty-page-code" aria-hidden>404</div>
      <h1>{t("common.pageNotFoundTitle")}</h1>
      <p className="muted">{t("common.pageNotFoundText")}</p>
      <Link className="btn primary" href="/">{t("common.goHome")}</Link>
    </main>
  );
}
