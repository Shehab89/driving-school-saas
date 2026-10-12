import { withTenant } from "@/lib/db";
import { Badge, Flash, sp, type SearchParams } from "@/components/ui";
import { formatDateTime } from "@/lib/time";
import { requireSchoolActor, requireSchoolPage } from "@/server/auth/session";
import { userPrincipal } from "@/server/principal";
import { schoolHeader } from "@/server/school";
import { grantSupportAccess, revokeSupportAccess, supportAccessHistory } from "@/server/services/support";
import { runAction, str } from "@/server/web";

async function grant(fd: FormData) {
  "use server";
  await runAction(async () => {
    const actor = await requireSchoolActor("school:manage_settings");
    await withTenant(actor.schoolId, (tx) => grantSupportAccess(tx, userPrincipal(actor), { hours: str(fd, "hours"), reason: str(fd, "reason") }));
  }, { back: "/admin/support", okMessage: "Support access granted" });
}

async function revoke(fd: FormData) {
  "use server";
  await runAction(async () => {
    const actor = await requireSchoolActor("school:manage_settings");
    await withTenant(actor.schoolId, (tx) => revokeSupportAccess(tx, userPrincipal(actor), str(fd, "grantId")));
  }, { back: "/admin/support", okMessage: "Support access revoked" });
}

export default async function SupportPage({ searchParams }: { searchParams: SearchParams }) {
  const q = await sp(searchParams);
  const actor = await requireSchoolPage("school:manage_settings");
  const [h, school] = await Promise.all([withTenant(actor.schoolId, (tx) => supportAccessHistory(tx)), schoolHeader(actor.schoolId)]);
  const fmt = (d: Date) => formatDateTime(d, school.timezone);
  return (
    <>
      <h1>Platform support access</h1>
      <Flash searchParams={q} />
      <p className="muted">
        DriveDesk support cannot see your team, settings or activity log unless you allow it here. Access is read-only, ends automatically,
        and every time support looks, it appears in the list below.
      </p>
      <form action={grant} className="card">
        <h2>Give support temporary access</h2>
        <div className="fields">
          <div className="field">
            <label htmlFor="hours">For how long</label>
            <select id="hours" name="hours" defaultValue="24"><option value="1">1 hour</option><option value="24">24 hours</option><option value="72">3 days</option></select>
          </div>
          <div className="field">
            <label htmlFor="reason">What do you need help with?</label>
            <input id="reason" name="reason" required minLength={3} maxLength={500} placeholder="e.g. reminders were not sent yesterday" />
          </div>
        </div>
        <button className="primary" type="submit">Grant access</button>
      </form>
      <div className="card table-wrap">
        <h2>Access you granted</h2>
        {h.grants.length === 0 ? <p className="muted">None yet.</p> : (
          <table>
            <thead><tr><th>Granted</th><th>Reason</th><th>Until</th><th>Status</th><th /></tr></thead>
            <tbody>
              {h.grants.map((g) => (
                <tr key={g.id}>
                  <td className="small">{fmt(g.created_at)}</td>
                  <td>{g.reason}</td>
                  <td className="small">{fmt(g.revoked_at ?? g.expires_at)}</td>
                  <td><Badge value={g.active ? "active" : "closed"} label={g.active ? "active" : g.revoked_at ? "revoked" : "expired"} /></td>
                  <td>{g.active && (
                    <form action={revoke}><input type="hidden" name="grantId" value={g.id} /><button className="danger" type="submit">Revoke now</button></form>
                  )}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      <div className="card">
        <h2>When support looked</h2>
        {h.views.length === 0 ? <p className="muted">Support has not viewed your school.</p> : (
          <ul>{h.views.map((v, i) => <li key={i} className="small">{fmt(v.created_at)} · {v.action.replace("support.", "").replace(/_/g, " ")}</li>)}</ul>
        )}
      </div>
    </>
  );
}
