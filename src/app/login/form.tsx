import Link from "next/link";
import { redirect } from "next/navigation";
import { Flash } from "@/components/ui";
import { LanguageSwitcher } from "@/components/language-switcher";
import { isLocale, type Locale, type Translate } from "@/i18n";
import { getI18n, setLocaleCookie } from "@/i18n/server";
import { createSession } from "@/server/auth/session";
import { login } from "@/server/services/auth";
import { homePathFor, type Role } from "@/lib/rbac";
import { str } from "@/server/web";

export type LoginApp = "student" | "instructor" | "portal";

const ALLOWED: Record<LoginApp, Role[] | null> = {
  student: ["student"],
  instructor: ["instructor", "school_owner", "school_admin"],
  portal: null,
};

async function loginAction(app: LoginApp, fd: FormData) {
  "use server";
  const { t } = await getI18n();
  const self = app === "portal" ? "/login" : `/login/${app}`;
  const result = await login(str(fd, "email"), str(fd, "password"), str(fd, "school") || undefined);
  if (!result.ok) {
    const msg = result.reason === "choose_school" ? t("auth.chooseSchool") : t("auth.invalid");
    redirect(`${self}?error=${encodeURIComponent(msg)}${result.reason === "choose_school" ? "&school=1" : ""}`);
  }
  const allowed = ALLOWED[app];
  if (allowed && !allowed.includes(result.role)) {
    redirect(`${self}?error=${encodeURIComponent(t(app === "student" ? "auth.wrongRoleStudent" : "auth.wrongRoleInstructor"))}`);
  }
  await createSession({ sub: result.userId, sid: result.schoolId, role: result.role, tv: result.tokenVersion });
  // Restore the language the user chose last time.
  if (isLocale(result.locale)) await setLocaleCookie(result.locale);
  redirect(app === "portal" ? homePathFor(result.role) : `/${app}`);
}

export function LoginForm({ app, t, locale, params }: { app: LoginApp; t: Translate; locale: Locale; params: Record<string, string> }) {
  const appName = app === "portal" ? "DriveDesk" : t(app === "student" ? "apps.student" : "apps.instructor");
  return (
    <main className="container narrow" style={{ paddingTop: 40 }}>
      <div className="spread" style={{ marginBottom: 20 }}>
        <div className="row">
          {app !== "portal" && <span className={`app-badge ${app}`} aria-hidden="true">{app === "student" ? "L" : "I"}</span>}
          <strong style={{ fontSize: "1.1rem" }}>{appName}</strong>
        </div>
        <LanguageSwitcher current={locale} label={t("common.language")} />
      </div>
      <h1>{app === "portal" ? t("auth.signIn") : t("auth.signInTo", { app: appName })}</h1>
      <Flash searchParams={params} />
      <form action={loginAction.bind(null, app)} className="card">
        <div className="field">
          <label htmlFor="email">{t("auth.email")}</label>
          <input id="email" name="email" type="email" dir="ltr" autoComplete="email" required />
        </div>
        <div className="field">
          <label htmlFor="password">{t("auth.password")}</label>
          <input id="password" name="password" type="password" dir="ltr" autoComplete="current-password" required />
        </div>
        <div className="field">
          <label htmlFor="school">{t("auth.schoolId")} <span className="muted small">({t("auth.schoolIdHint")})</span></label>
          <input id="school" name="school" dir="ltr" placeholder="abc-driving" autoFocus={params.school === "1"} />
        </div>
        <button className="primary block" type="submit">{t("auth.signIn")}</button>
      </form>
      <p className="muted small">{t("auth.otherApps")}</p>
      <div className="auth-apps">
        {app !== "student" && <Link href="/login/student"><span className="app-badge student" aria-hidden="true">L</span>{t("apps.student")}</Link>}
        {app !== "instructor" && <Link href="/login/instructor"><span className="app-badge instructor" aria-hidden="true">I</span>{t("apps.instructor")}</Link>}
        {app !== "portal" && <Link href="/login"><span className="app-badge" style={{ background: "#5f6b7a" }} aria-hidden="true">S</span>DriveDesk</Link>}
      </div>
    </main>
  );
}
