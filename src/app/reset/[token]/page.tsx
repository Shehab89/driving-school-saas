import Link from "next/link";
import { redirect } from "next/navigation";
import { Flash, sp, type SearchParams } from "@/components/ui";
import { createSession } from "@/server/auth/session";
import { resetPassword } from "@/server/services/auth";
import { deliverNotifications } from "@/server/jobs";
import { homePathFor } from "@/lib/rbac";
import { AppError } from "@/lib/errors";
import { str } from "@/server/web";
import { getI18n } from "@/i18n/server";
import { after } from "next/server";

export default async function ResetPage({ params, searchParams }: { params: Promise<{ token: string }>; searchParams: SearchParams }) {
  const { token } = await params;
  const q = await sp(searchParams);
  const { t } = await getI18n();

  async function reset(fd: FormData) {
    "use server";
    const { t } = await getI18n();
    const password = str(fd, "password");
    if (password !== str(fd, "confirm")) redirect(`/reset/${token}?error=${encodeURIComponent(t("auth.passwordsDontMatch"))}`);
    let user;
    try {
      user = await resetPassword(token, password);
    } catch (err) {
      redirect(`/reset/${token}?error=${encodeURIComponent(err instanceof AppError ? err.message : t("errors.generic"))}`);
    }
    after(() => deliverNotifications(10).catch(() => undefined));
    await createSession({ sub: user.id, sid: user.school_id, role: user.role, tv: user.token_version });
    redirect(`${homePathFor(user.role)}?ok=${encodeURIComponent(t("auth.resetDone"))}`);
  }

  return (
    <main className="container narrow" style={{ paddingTop: 48, maxWidth: 440 }}>
      <h1>{t("auth.resetTitle")}</h1>
      <Flash searchParams={q} />
      <form action={reset} className="card">
        <div className="field">
          <label htmlFor="password">{t("auth.newPassword")}</label>
          <input id="password" name="password" type="password" minLength={10} autoComplete="new-password" required />
        </div>
        <div className="field">
          <label htmlFor="confirm">{t("auth.repeatPassword")}</label>
          <input id="confirm" name="confirm" type="password" minLength={10} autoComplete="new-password" required />
        </div>
        <button className="primary block" type="submit">{t("auth.resetSubmit")}</button>
      </form>
      <p><Link href="/forgot">{t("auth.forgotPassword")}</Link></p>
    </main>
  );
}
