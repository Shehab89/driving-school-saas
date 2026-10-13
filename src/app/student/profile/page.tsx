import { many, one, withTenant } from "@/lib/db";
import { Flash, sp, type SearchParams } from "@/components/ui";
import { getI18n } from "@/i18n/server";
import { requireSchoolActor, requireSchoolPage } from "@/server/auth/session";
import { userPrincipal } from "@/server/principal";
import { schoolI18n } from "@/server/school";
import { updateOwnStudentProfile } from "@/server/services/students";
import { runAction, str } from "@/server/web";
import { LanguageSwitcher } from "@/components/language-switcher";
import { PasswordForm } from "@/components/password-form";
import { hasWhatsAppConsent, parseStudentPrefs, setWhatsAppConsent, updateStudentPrefs } from "@/server/services/notification-prefs";

async function savePrefs(fd: FormData) {
  "use server";
  const { t } = await getI18n();
  await runAction(
    async () => {
      const actor = await requireSchoolActor("profile:write_own");
      const on = (k: string) => fd.get(k) === "on";
      await withTenant(actor.schoolId, async (tx) => {
        const p = userPrincipal(actor);
        await updateStudentPrefs(tx, p, actor.studentId!, {
          reminders: { email: on("reminders_email"), whatsapp: on("reminders_whatsapp") },
          lesson_updates: { email: on("lesson_updates_email"), whatsapp: on("lesson_updates_whatsapp") },
        });
        // Consent is a separate, explicit tick box; it is recorded with a timestamp.
        if (on("whatsapp_consent") && fd.get("had_consent") !== "1") await setWhatsAppConsent(tx, p, actor.studentId!, true, "app");
      });
    },
    { back: "/student/profile", okMessage: t("student.notifSaved") },
  );
}

async function stopWhatsApp() {
  "use server";
  const { t } = await getI18n();
  await runAction(
    async () => {
      const actor = await requireSchoolActor("profile:write_own");
      await withTenant(actor.schoolId, (tx) => setWhatsAppConsent(tx, userPrincipal(actor), actor.studentId!, false, "app"));
    },
    { back: "/student/profile", okMessage: t("student.notifSaved") },
  );
}

async function saveProfile(fd: FormData) {
  "use server";
  const { t } = await getI18n();
  await runAction(
    async () => {
      const actor = await requireSchoolActor("profile:write_own");
      const availability = [1, 2, 3, 4, 5, 6, 7].flatMap((d) => {
        const start = str(fd, `start_${d}`);
        const end = str(fd, `end_${d}`);
        return start && end ? [{ weekday: d, start, end }] : [];
      });
      await withTenant(actor.schoolId, (tx) =>
        updateOwnStudentProfile(tx, userPrincipal(actor), { phone: str(fd, "phone"), preferredTransmission: str(fd, "transmission") as "manual" | "automatic", availability }),
      );
    },
    { back: "/student/profile", okMessage: t("student.profileSaved") },
  );
}

export default async function ProfilePage({ searchParams }: { searchParams: SearchParams }) {
  const q = await sp(searchParams);
  const actor = await requireSchoolPage("profile:write_own");
  const { t, f, locale, school } = await schoolI18n(actor.schoolId);
  const d = await withTenant(actor.schoolId, async (tx) => ({
    s: (await one<{ first_name: string; last_name: string; email: string | null; phone: string | null; phone_e164: string | null; preferred_transmission: string; student_number: string; notification_prefs: unknown; whatsapp_opt_in_at: Date | null; whatsapp_opt_out_at: Date | null }>(
      tx,
      `SELECT first_name, last_name, email, phone, phone_e164, preferred_transmission, student_number, notification_prefs, whatsapp_opt_in_at, whatsapp_opt_out_at FROM students WHERE id = $1`,
      [actor.studentId],
    ))!,
    av: await many<{ weekday: number; start: string; end: string }>(
      tx,
      `SELECT weekday, to_char(start_time,'HH24:MI') AS start, to_char(end_time,'HH24:MI') AS "end" FROM student_availability WHERE student_id = $1`,
      [actor.studentId],
    ),
    whatsappOffered: Boolean(await one(tx, `SELECT 1 FROM whatsapp_accounts WHERE status = 'active' AND templates <> '{}'::jsonb`)),
  }));
  const prefs = parseStudentPrefs(d.s.notification_prefs);
  const consent = hasWhatsAppConsent(d.s.whatsapp_opt_in_at, d.s.whatsapp_opt_out_at);
  return (
    <>
      <div className="page-head"><h1>{t("student.profileTitle")}</h1></div>
      <Flash searchParams={q} />
      <section className="card spread">
        <strong>{t("common.language")}</strong>
        <LanguageSwitcher current={locale} label={t("common.language")} />
      </section>
      <form action={saveProfile} className="card">
        <p className="muted small">{d.s.first_name} {d.s.last_name} · {d.s.student_number} · <span dir="ltr">{d.s.email}</span></p>
        <div className="field">
          <label htmlFor="phone">{t("student.phoneLabel")}</label>
          <input id="phone" name="phone" dir="ltr" defaultValue={d.s.phone ?? ""} placeholder="+31 6 1234 5678" />
        </div>
        <div className="field">
          <label htmlFor="transmission">{t("student.transmission")}</label>
          <select id="transmission" name="transmission" defaultValue={d.s.preferred_transmission}>
            <option value="manual">{t("student.manual")}</option>
            <option value="automatic">{t("student.automatic")}</option>
          </select>
        </div>
        <h2>{t("student.availabilityTitle")}</h2>
        <p className="muted small">{t("student.availabilityHint")}</p>
        {[1, 2, 3, 4, 5, 6, 7].map((day) => {
          const w = d.av.find((a) => a.weekday === day);
          return (
            <div className="row" key={day} style={{ marginBottom: 6 }}>
              <span style={{ width: 90 }}>{f.weekday(day)}</span>
              <input aria-label={`${f.weekday(day)} ${t("student.from")}`} type="time" name={`start_${day}`} defaultValue={w?.start ?? ""} style={{ width: 120 }} />
              <span>–</span>
              <input aria-label={`${f.weekday(day)} ${t("student.until")}`} type="time" name={`end_${day}`} defaultValue={w?.end ?? ""} style={{ width: 120 }} />
            </div>
          );
        })}
        <button className="primary" type="submit" style={{ marginTop: 12 }}>{t("common.save")}</button>
      </form>
      <form action={savePrefs} className="card">
        <h2>{t("student.notifTitle")}</h2>
        <table>
          <thead><tr><th /><th>{t("student.channelEmail")}</th>{d.whatsappOffered && <th>{t("student.channelWhatsapp")}</th>}</tr></thead>
          <tbody>
            {(["reminders", "lesson_updates"] as const).map((cat) => (
              <tr key={cat}>
                <td>{t(cat === "reminders" ? "student.notifReminders" : "student.notifUpdates")}</td>
                <td><input type="checkbox" name={`${cat}_email`} defaultChecked={prefs[cat].email} aria-label={`${t(cat === "reminders" ? "student.notifReminders" : "student.notifUpdates")}: ${t("student.channelEmail")}`} /></td>
                {d.whatsappOffered && <td><input type="checkbox" name={`${cat}_whatsapp`} defaultChecked={prefs[cat].whatsapp} aria-label={`${t(cat === "reminders" ? "student.notifReminders" : "student.notifUpdates")}: ${t("student.channelWhatsapp")}`} /></td>}
              </tr>
            ))}
          </tbody>
        </table>
        {d.whatsappOffered ? (
          !d.s.phone_e164 ? <p className="small muted">{t("student.whatsappNeedsPhone")}</p>
          : consent ? <p className="small muted">{t("student.whatsappConsentSince", { date: f.shortDate(d.s.whatsapp_opt_in_at!) })}</p>
          : <label className="check small"><input type="checkbox" name="whatsapp_consent" /> {t("student.whatsappConsent", { school: school.name })}</label>
        ) : <p className="small muted">{t("student.whatsappNotOffered")}</p>}
        <input type="hidden" name="had_consent" value={consent ? "1" : "0"} />
        <p className="small muted">{t("student.notifAlways")}</p>
        <button className="primary" type="submit">{t("common.save")}</button>
      </form>
      {consent && (
        <form action={stopWhatsApp}>
          <button type="submit" className="block">{t("student.whatsappStop")}</button>
        </form>
      )}
      <PasswordForm t={t} back="/student/profile" />
      <section className="card">
        <h2>{t("student.myDataTitle")}</h2>
        <p className="row">
          <a className="btn" href={`/progress/${actor.studentId}`}>{t("report.title")}</a>
          <a className="btn" href={`/api/students/${actor.studentId}/export`}>{t("student.downloadData")}</a>
        </p>
        <p className="small muted">{t("student.erasureInfo", { school: school.name })}</p>
      </section>
      <form action="/logout" method="post">
        <button type="submit" className="block">{t("common.logout")}</button>
      </form>
    </>
  );
}
