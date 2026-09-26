import { many, one, withTenant } from "@/lib/db";
import { Flash, sp, type SearchParams } from "@/components/ui";
import { getI18n } from "@/i18n/server";
import { requireSchoolActor, requireSchoolPage } from "@/server/auth/session";
import { userPrincipal } from "@/server/principal";
import { schoolI18n } from "@/server/school";
import { updateOwnStudentProfile } from "@/server/services/students";
import { runAction, str } from "@/server/web";
import { LanguageSwitcher } from "@/components/language-switcher";

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
  const { t, f, locale } = await schoolI18n(actor.schoolId);
  const d = await withTenant(actor.schoolId, async (tx) => ({
    s: (await one<{ first_name: string; last_name: string; email: string | null; phone: string | null; preferred_transmission: string; student_number: string }>(
      tx,
      `SELECT first_name, last_name, email, phone, preferred_transmission, student_number FROM students WHERE id = $1`,
      [actor.studentId],
    ))!,
    av: await many<{ weekday: number; start: string; end: string }>(
      tx,
      `SELECT weekday, to_char(start_time,'HH24:MI') AS start, to_char(end_time,'HH24:MI') AS "end" FROM student_availability WHERE student_id = $1`,
      [actor.studentId],
    ),
  }));
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
      <form action="/logout" method="post">
        <button type="submit" className="block">{t("common.logout")}</button>
      </form>
    </>
  );
}
