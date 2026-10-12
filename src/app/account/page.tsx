import { Flash, Shell, sp, type SearchParams } from "@/components/ui";
import { PasswordForm } from "@/components/password-form";
import { requirePage, requireSchoolActor } from "@/server/auth/session";
import { translator } from "@/i18n";
import { one, withTenant } from "@/lib/db";
import { can } from "@/lib/rbac";
import { userPrincipal } from "@/server/principal";
import { parseUserPrefs, updateUserPrefs } from "@/server/services/notification-prefs";
import { runAction } from "@/server/web";

async function savePrefs(fd: FormData) {
  "use server";
  await runAction(async () => {
    const actor = await requireSchoolActor("whatsapp:inbox");
    await withTenant(actor.schoolId, (tx) => updateUserPrefs(tx, userPrincipal(actor), { handoff: fd.get("handoff") === "on" }));
  }, { back: "/account", okMessage: "Saved" });
}

/** Account page for portal users (owners, admins, platform admins). The portal is English-only. */
export default async function AccountPage({ searchParams }: { searchParams: SearchParams }) {
  const q = await sp(searchParams);
  const actor = await requirePage();
  const inbox = actor.schoolId && can(actor.role, "whatsapp:inbox");
  const prefs = inbox
    ? parseUserPrefs((await withTenant(actor.schoolId!, (tx) => one<{ notification_prefs: unknown }>(tx, `SELECT notification_prefs FROM users WHERE id = $1`, [actor.userId])))?.notification_prefs)
    : null;
  return (
    <Shell role={actor.role} title="Account">
      <h1>Account</h1>
      <Flash searchParams={q} />
      <section className="card">
        <dl className="kv"><dt>E-mail</dt><dd>{actor.email}</dd><dt>Role</dt><dd>{actor.role.replace(/_/g, " ")}</dd></dl>
      </section>
      {prefs && (
        <form action={savePrefs} className="card">
          <h2>E-mails to me</h2>
          <label className="check"><input type="checkbox" name="handoff" defaultChecked={prefs.handoff} /> E-mail me when a WhatsApp conversation needs a person</label>
          <button type="submit" style={{ marginTop: 8 }}>Save</button>
        </form>
      )}
      <PasswordForm t={translator("en")} back="/account" />
    </Shell>
  );
}
