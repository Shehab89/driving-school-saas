import Link from "next/link";
import { redirect } from "next/navigation";
import { headers } from "next/headers";
import { withTenant } from "@/lib/db";
import { AppError } from "@/lib/errors";
import { ZodError } from "zod";
import { allow } from "@/lib/rate-limit";
import { Flash, sp, type SearchParams } from "@/components/ui";
import { LanguageSwitcher } from "@/components/language-switcher";
import { Logo } from "@/components/brand";
import { getI18n } from "@/i18n/server";
import { tryTranslate } from "@/i18n";
import { createSession } from "@/server/auth/session";
import { acceptInvite } from "@/server/services/auth";
import { findSchoolForSignup, signUpStudent } from "@/server/services/signup";
import { bool, num, optStr, str } from "@/server/web";

/**
 * Public "book my first lesson" survey. Reachable at /join (when the
 * deployment hosts exactly one school) or /join/<slug>. Ends by signing the
 * new student straight in and sending them to the booking calendar, so
 * "fill the survey" and "pick a time" happen in one visit.
 */
export async function JoinPage({ slug, searchParams }: { slug?: string; searchParams: SearchParams }) {
  const q = await sp(searchParams);
  const { t, f, locale } = await getI18n();
  const result = await findSchoolForSignup(slug);

  async function join(fd: FormData) {
    "use server";
    const { t } = await getI18n();
    const back = slug ? `/join/${slug}` : "/join";
    const ip = (await headers()).get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
    if (!allow(`join:ip:${ip}`, 6, 60_000)) {
      redirect(`${back}?error=${encodeURIComponent(t("auth.tooManyAttempts"))}`);
    }
    const result = await findSchoolForSignup(slug);
    if (!result.ok) redirect(`${back}?error=${encodeURIComponent(t("join.notAccepting"))}`);
    const school = result.school;
    const password = str(fd, "password");
    if (password !== str(fd, "confirmPassword")) {
      redirect(`${back}?error=${encodeURIComponent(t("auth.passwordsDontMatch"))}`);
    }
    try {
      const { activationToken } = await withTenant(school.id, (tx) =>
        signUpStudent(tx, school.id, {
          firstName: str(fd, "firstName"),
          lastName: str(fd, "lastName"),
          email: str(fd, "email"),
          phone: str(fd, "phone"),
          password,
          answers: {
            has_driven_before: bool(fd, "has_driven_before"),
            previous_lessons: str(fd, "previous_lessons") as never,
            approx_driving_hours: num(fd, "approx_driving_hours") ?? null,
            can_drive_manual: str(fd, "can_drive_manual") as never,
            traffic_comfort: num(fd, "traffic_comfort") ?? 3,
            has_foreign_license: bool(fd, "has_foreign_license"),
            wants_transmission: str(fd, "wants_transmission") as never,
            notes: optStr(fd, "notes"),
          },
        }),
      );
      // Activate with the password just chosen, in its own transaction (see signUpStudent's doc
      // comment for why), then sign them in with the fresh, now-active claims.
      const account = await acceptInvite(activationToken, password);
      await createSession({ sub: account.id, sid: account.school_id, role: account.role, tv: account.token_version });
    } catch (err) {
      const { locale } = await getI18n();
      const message =
        err instanceof AppError
          ? (tryTranslate(locale, `errors.${err.code}`) ?? err.message)
          : err instanceof ZodError
            ? tryTranslate(locale, "errors.validation_error")!
            : t("errors.generic");
      redirect(`${back}?error=${encodeURIComponent(message)}`);
    }
    redirect("/student/book?ok=" + encodeURIComponent(t("join.welcome")));
  }

  return (
    <main className="container narrow" style={{ paddingTop: 32, maxWidth: 520, paddingBottom: 48 }}>
      <div className="spread" style={{ marginBottom: 24 }}>
        <Logo size={30} />
        <LanguageSwitcher current={locale} label={t("common.language")} />
      </div>
      {!result.ok && result.reason === "choose" ? (
        <>
          <h1>{t("join.heading")}</h1>
          <p className="muted">{t("join.chooseSchool")}</p>
          <div style={{ display: "grid", gap: 8 }}>
            {result.schools.map((sc) => (
              <Link key={sc.slug} href={`/join/${sc.slug}`} className="card spread" style={{ display: "flex", color: "inherit", textDecoration: "none", margin: 0 }}>
                <strong>{sc.name}</strong>
                <span aria-hidden className="flip">›</span>
              </Link>
            ))}
          </div>
        </>
      ) : !result.ok ? (
        <div className="card"><p>{result.reason === "not_found" ? t("join.notFound") : t("join.notAccepting")}</p></div>
      ) : (
        <>
          <h1>{t("join.heading")}</h1>
          <p className="muted">{t("join.intro")}</p>
          <p className="card" style={{ background: "var(--accent-soft)", borderColor: "transparent", fontWeight: 600 }}>
            {t("join.priceLine", { price: f.money(result.school.priceCents, result.school.currency), minutes: result.school.minutes })}
          </p>
          <Flash searchParams={q} />
          <form action={join} className="card" style={{ display: "grid", gap: 18 }}>
            <fieldset style={{ border: 0, padding: 0, margin: 0, display: "grid", gap: 12 }}>
              <legend style={{ fontWeight: 700, marginBottom: 4, padding: 0 }}>{t("join.contactHeading")}</legend>
              <div className="grid two">
                <div className="field">
                  <label htmlFor="firstName">{t("join.firstName")}</label>
                  <input id="firstName" name="firstName" required maxLength={100} autoComplete="given-name" />
                </div>
                <div className="field">
                  <label htmlFor="lastName">{t("join.lastName")}</label>
                  <input id="lastName" name="lastName" required maxLength={100} autoComplete="family-name" />
                </div>
              </div>
              <div className="field">
                <label htmlFor="email">{t("join.email")}</label>
                <input id="email" name="email" type="email" dir="ltr" required autoComplete="email" />
              </div>
              <div className="field">
                <label htmlFor="phone">{t("join.phone")}</label>
                <input id="phone" name="phone" type="tel" dir="ltr" required autoComplete="tel" />
              </div>
              <div className="field">
                <label htmlFor="password">{t("auth.newPassword")}</label>
                <input id="password" name="password" type="password" dir="ltr" minLength={10} required autoComplete="new-password" />
              </div>
              <div className="field">
                <label htmlFor="confirmPassword">{t("auth.repeatPassword")}</label>
                <input id="confirmPassword" name="confirmPassword" type="password" dir="ltr" minLength={10} required autoComplete="new-password" />
              </div>
            </fieldset>

            <fieldset style={{ border: 0, padding: 0, margin: 0, display: "grid", gap: 14 }}>
              <legend style={{ fontWeight: 700, marginBottom: 4, padding: 0 }}>{t("join.levelHeading")}</legend>

              <YesNo name="has_driven_before" label={t("join.hasDrivenBefore")} yes={t("join.yes")} no={t("join.no")} />

              <div className="field">
                <label htmlFor="previous_lessons">{t("join.previousLessons")}</label>
                <select id="previous_lessons" name="previous_lessons" defaultValue="none" required>
                  <option value="none">{t("join.lessonsNone")}</option>
                  <option value="few">{t("join.lessonsFew")}</option>
                  <option value="some">{t("join.lessonsSome")}</option>
                  <option value="many">{t("join.lessonsMany")}</option>
                </select>
              </div>

              <div className="field">
                <label htmlFor="approx_driving_hours">{t("join.drivingHours")} <span className="muted small">({t("join.optional")})</span></label>
                <input id="approx_driving_hours" name="approx_driving_hours" type="number" min={0} max={10000} inputMode="numeric" />
              </div>

              <div className="field">
                <label htmlFor="can_drive_manual">{t("join.canDriveManual")}</label>
                <select id="can_drive_manual" name="can_drive_manual" defaultValue="unsure" required>
                  <option value="yes">{t("join.yes")}</option>
                  <option value="no">{t("join.no")}</option>
                  <option value="unsure">{t("join.unsure")}</option>
                </select>
              </div>

              <div className="field">
                <span>{t("join.trafficComfort")}</span>
                <div className="row" style={{ justifyContent: "space-between", marginTop: 6 }} dir="ltr">
                  {[1, 2, 3, 4, 5].map((n) => (
                    <label key={n} className="slot-option" style={{ flexDirection: "column", gap: 4, padding: "8px 10px" }}>
                      <input type="radio" name="traffic_comfort" value={n} defaultChecked={n === 3} required />
                      <span>{n}</span>
                    </label>
                  ))}
                </div>
                <div className="spread muted small" style={{ marginTop: 2 }}>
                  <span>{t("join.comfort1")}</span>
                  <span>{t("join.comfort5")}</span>
                </div>
              </div>

              <label className="row" style={{ gap: 8, fontWeight: 500 }}>
                <input type="checkbox" name="has_foreign_license" />
                {t("join.foreignLicense")}
              </label>
            </fieldset>

            <fieldset style={{ border: 0, padding: 0, margin: 0, display: "grid", gap: 8 }}>
              <legend style={{ fontWeight: 700, marginBottom: 4, padding: 0 }}>{t("join.transmissionHeading")}</legend>
              <div className="row">
                <label className="slot-option" style={{ flex: 1 }}>
                  <input type="radio" name="wants_transmission" value="manual" defaultChecked required />
                  {t("join.manual")}
                </label>
                <label className="slot-option" style={{ flex: 1 }}>
                  <input type="radio" name="wants_transmission" value="automatic" />
                  {t("join.automatic")}
                </label>
              </div>
            </fieldset>

            <div className="field">
              <label htmlFor="notes">{t("join.notes")} <span className="muted small">({t("join.optional")})</span></label>
              <textarea id="notes" name="notes" maxLength={1000} rows={3} />
            </div>

            <button className="primary block" type="submit">{t("join.submit")}</button>
          </form>
          <p className="muted small" style={{ textAlign: "center" }}>
            {t("join.alreadyHaveAccount")} <a href="/login/student">{t("join.signIn")}</a>
          </p>
        </>
      )}
    </main>
  );
}

function YesNo({ name, label, yes, no }: { name: string; label: string; yes: string; no: string }) {
  return (
    <div className="field">
      <span>{label}</span>
      <div className="row" style={{ marginTop: 6 }}>
        <label className="slot-option" style={{ flex: 1 }}>
          <input type="radio" name={name} value="true" required />
          {yes}
        </label>
        <label className="slot-option" style={{ flex: 1 }}>
          <input type="radio" name={name} value="false" defaultChecked />
          {no}
        </label>
      </div>
    </div>
  );
}
