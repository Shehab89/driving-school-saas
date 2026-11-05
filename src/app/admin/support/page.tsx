import { withTenant } from "@/lib/db";
import { Badge, Flash, sp, type SearchParams } from "@/components/ui";
import { requireSchoolActor, requireSchoolPage } from "@/server/auth/session";
import { userPrincipal } from "@/server/principal";
import { schoolI18n } from "@/server/school";
import { getPt } from "@/i18n/server";
import { grantSupportAccess, revokeSupportAccess, supportAccessHistory } from "@/server/services/support";
import { runAction, str } from "@/server/web";

async function grant(fd: FormData) {
  "use server";
  const pt = await getPt();
  await runAction(async () => {
    const actor = await requireSchoolActor("school:manage_settings");
    await withTenant(actor.schoolId, (tx) => grantSupportAccess(tx, userPrincipal(actor), { hours: str(fd, "hours"), reason: str(fd, "reason") }));
  }, { back: "/admin/support", okMessage: pt("Support access granted") });
}

async function revoke(fd: FormData) {
  "use server";
  const pt = await getPt();
  await runAction(async () => {
    const actor = await requireSchoolActor("school:manage_settings");
    await withTenant(actor.schoolId, (tx) => revokeSupportAccess(tx, userPrincipal(actor), str(fd, "grantId")));
  }, { back: "/admin/support", okMessage: pt("Support access ended") });
}

export default async function SupportPage({ searchParams }: { searchParams: SearchParams }) {
  const q = await sp(searchParams);
  const actor = await requireSchoolPage("school:manage_settings");
  const h = await withTenant(actor.schoolId, (tx) => supportAccessHistory(tx));
  const { f, pt } = await schoolI18n(actor.schoolId);
  const fmt = (d: Date) => f.dateTime(d);
  return (
    <>
      <div className="page-title">
        <div>
          <h1>{pt("Support access")}</h1>
          <p>{pt("DriveDesk support cannot see your team, settings or activity log unless you allow it here. Access is read-only, ends by itself, and every look is listed below.")}</p>
        </div>
      </div>
      <Flash searchParams={q} />
      <form action={grant} className="card">
        <h2>{pt("Give support temporary access")}</h2>
        <div className="fields">
          <div className="field">
            <label htmlFor="hours">{pt("For how long")}</label>
            <select id="hours" name="hours" defaultValue="24"><option value="1">{pt("1 hour")}</option><option value="24">{pt("24 hours")}</option><option value="72">{pt("3 days")}</option></select>
          </div>
          <div className="field">
            <label htmlFor="reason">{pt("What do you need help with?")}</label>
            <input id="reason" name="reason" required minLength={3} maxLength={500} placeholder={pt("e.g. reminders were not sent yesterday")} />
          </div>
        </div>
        <button className="primary" type="submit">{pt("Give access")}</button>
      </form>
      <div className="card table-card">
        <h2>{pt("Access you gave")}</h2>
        {h.grants.length === 0 ? <p className="empty">{pt("None yet.")}</p> : (
          <div className="table-wrap">
          <table className="stack-table">
            <thead><tr><th>{pt("Given")}</th><th>{pt("Reason")}</th><th>{pt("Until")}</th><th>{pt("Status")}</th><th /></tr></thead>
            <tbody>
              {h.grants.map((g) => (
                <tr key={g.id}>
                  <td data-label={pt("Given")} className="small">{fmt(g.created_at)}</td>
                  <td data-label={pt("Reason")}>{g.reason}</td>
                  <td data-label={pt("Until")} className="small">{fmt(g.revoked_at ?? g.expires_at)}</td>
                  <td data-label={pt("Status")}><Badge value={g.active ? "active" : "closed"} label={g.active ? pt("Active") : g.revoked_at ? pt("Ended by you") : pt("Expired")} /></td>
                  <td>{g.active && (
                    <form action={revoke}><input type="hidden" name="grantId" value={g.id} /><button className="danger sm" type="submit">{pt("End access now")}</button></form>
                  )}</td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>
        )}
      </div>
      <div className="card">
        <h2>{pt("When support looked")}</h2>
        {h.views.length === 0 ? <p className="muted">{pt("Support has not looked at your school.")}</p> : (
          <ul>{h.views.map((v, i) => <li key={i} className="small">{fmt(v.created_at)} · {v.action.replace("support.", "").replace(/_/g, " ")}</li>)}</ul>
        )}
      </div>
    </>
  );
}
