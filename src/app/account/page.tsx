import { redirect } from "next/navigation";
import { Flash, Shell, sp, type SearchParams } from "@/components/ui";
import { PasswordForm } from "@/components/password-form";
import { requirePage, requireSchoolActor } from "@/server/auth/session";
import { translator } from "@/i18n";
import { getLocale, getPt } from "@/i18n/server";
import { portalTranslator } from "@/i18n/portal";
import { schoolBrand, schoolHeader } from "@/server/school";
import { one, withTenant } from "@/lib/db";
import { can } from "@/lib/rbac";
import { userPrincipal } from "@/server/principal";
import { parseUserPrefs, updateUserPrefs } from "@/server/services/notification-prefs";
import { runAction } from "@/server/web";
import { CalendarSyncCard } from "@/components/calendar-sync";
import { currentFeedUrl } from "@/server/services/calendar-feed";

async function savePrefs(fd: FormData) {
  "use server";
  const pt = await getPt();
  await runAction(async () => {
    const actor = await requireSchoolActor("whatsapp:inbox");
    await withTenant(actor.schoolId, (tx) => updateUserPrefs(tx, userPrincipal(actor), { handoff: fd.get("handoff") === "on" }));
  }, { back: "/account", okMessage: pt("Saved") });
}

/** Account page for portal users (owners, admins, platform admins). */
export default async function AccountPage({ searchParams }: { searchParams: SearchParams }) {
  const q = await sp(searchParams);
  const actor = await requirePage();
  // Students and instructors have their own account screen inside their app.
  if (actor.role === "student") redirect("/student/profile");
  if (actor.role === "instructor") redirect("/instructor/profile");
  const inbox = actor.schoolId && can(actor.role, "whatsapp:inbox");
  const prefs = inbox
    ? parseUserPrefs((await withTenant(actor.schoolId!, (tx) => one<{ notification_prefs: unknown }>(tx, `SELECT notification_prefs FROM users WHERE id = $1`, [actor.userId])))?.notification_prefs)
    : null;
  const feed = actor.schoolId ? await withTenant(actor.schoolId, (tx) => currentFeedUrl(tx, actor.userId)) : undefined;
  const locale = await getLocale();
  const pt = portalTranslator(locale);
  const title = actor.schoolId ? (await schoolHeader(actor.schoolId)).name : pt("Platform admin");
  const ROLE: Record<string, string> = { school_owner: pt("Owner"), school_admin: pt("Office staff"), instructor: pt("Instructor"), saas_admin: pt("Platform admin"), student: pt("Student") };
  return (
    <Shell role={actor.role} title={title} brand={actor.schoolId ? await schoolBrand(actor.schoolId) : undefined}>
      <div className="narrow" style={{ maxWidth: 680 }}>
      <div className="page-title"><div><h1>{pt("My account")}</h1></div></div>
      <Flash searchParams={q} />
      <section className="card">
        <dl className="kv"><dt>{pt("E-mail")}</dt><dd dir="ltr" style={{ textAlign: "start" }}>{actor.email}</dd><dt>{pt("Role")}</dt><dd>{ROLE[actor.role] ?? actor.role}</dd></dl>
      </section>
      {prefs && (
        <form action={savePrefs} className="card">
          <h2>{pt("E-mails to me")}</h2>
          <label className="switch">{pt("E-mail me when a WhatsApp conversation needs a person")}<input type="checkbox" name="handoff" defaultChecked={prefs.handoff} /></label>
          <button type="submit" className="sm" style={{ marginTop: 10 }}>{pt("Save")}</button>
        </form>
      )}
      {feed !== undefined && <CalendarSyncCard url={feed} back="/account" t={translator(locale)} />}
      <PasswordForm t={translator(locale)} back="/account" />
      </div>
    </Shell>
  );
}
