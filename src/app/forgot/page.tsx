import Link from "next/link";
import { redirect } from "next/navigation";
import { headers } from "next/headers";
import { Flash, sp, type SearchParams } from "@/components/ui";
import { Logo } from "@/components/brand";
import { getI18n } from "@/i18n/server";
import { allow, clientIp } from "@/lib/rate-limit";
import { requestPasswordReset } from "@/server/services/auth";
import { deliverNotifications } from "@/server/jobs";
import { str } from "@/server/web";
import { after } from "next/server";

const BACK: Record<string, string> = { student: "/login/student", instructor: "/login/instructor" };

async function requestReset(fd: FormData) {
  "use server";
  const { t } = await getI18n();
  const app = str(fd, "app");
  const self = `/forgot${BACK[app] ? `?app=${app}` : ""}`;
  const sep = self.includes("?") ? "&" : "?";
  const email = str(fd, "email").toLowerCase();
  const ip = clientIp(await headers());
  if (!(await allow(`reset:ip:${ip}`, 10, 15 * 60_000)) || !(await allow(`reset:email:${email}`, 3, 15 * 60_000))) {
    redirect(`${self}${sep}error=${encodeURIComponent(t("auth.tooManyAttempts"))}`);
  }
  await requestPasswordReset(email, str(fd, "school") || undefined);
  after(() => deliverNotifications(10).catch(() => undefined));
  // Same answer whether or not the account exists.
  redirect(`${self}${sep}ok=${encodeURIComponent(t("auth.resetSent"))}`);
}

export default async function ForgotPage({ searchParams }: { searchParams: SearchParams }) {
  const q = await sp(searchParams);
  const { t } = await getI18n();
  const back = BACK[q.app ?? ""] ?? "/login";
  return (
    <main className="container narrow" style={{ paddingTop: 32, maxWidth: 440 }}>
      <div style={{ marginBottom: 28 }}><Logo size={30} /></div>
      <h1>{t("auth.forgotTitle")}</h1>
      <Flash searchParams={q} />
      <form action={requestReset} className="card">
        <p className="muted">{t("auth.forgotIntro")}</p>
        <input type="hidden" name="app" value={q.app ?? ""} />
        <div className="field">
          <label htmlFor="email">{t("auth.email")}</label>
          <input id="email" name="email" type="email" dir="ltr" autoComplete="email" required />
        </div>
        <div className="field">
          <label htmlFor="school">{t("auth.schoolId")} <span className="muted small">({t("auth.schoolIdHint")})</span></label>
          <input id="school" name="school" dir="ltr" />
        </div>
        <button className="primary block" type="submit">{t("auth.sendResetLink")}</button>
      </form>
      <p><Link href={back}>{t("auth.backToSignIn")}</Link></p>
    </main>
  );
}
