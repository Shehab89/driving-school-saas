import { withTenant } from "@/lib/db";
import { Badge, Flash, sp, type SearchParams } from "@/components/ui";
import { formatDateTime } from "@/lib/time";
import { requireSchoolActor, requireSchoolPage } from "@/server/auth/session";
import { userPrincipal } from "@/server/principal";
import { schoolHeader } from "@/server/school";
import { changeUserRole, inviteAdmin, listTeam, setUserStatus } from "@/server/services/team";
import { deliverNotifications } from "@/server/jobs";
import { runAction, str } from "@/server/web";
import { after } from "next/server";

async function invite(fd: FormData) {
  "use server";
  await runAction(async () => {
    const actor = await requireSchoolActor("team:manage");
    await withTenant(actor.schoolId, (tx) => inviteAdmin(tx, userPrincipal(actor), { email: str(fd, "email"), name: str(fd, "name") }));
    after(() => deliverNotifications(10).catch(() => undefined));
  }, { back: "/admin/team", okMessage: "Invitation sent" });
}

async function status(fd: FormData) {
  "use server";
  await runAction(async () => {
    const actor = await requireSchoolActor("team:manage");
    await withTenant(actor.schoolId, (tx) => setUserStatus(tx, userPrincipal(actor), str(fd, "userId"), str(fd, "status") === "disabled" ? "disabled" : "active"));
  }, { back: "/admin/team", okMessage: "Account updated. Their open sessions were signed out." });
}

async function role(fd: FormData) {
  "use server";
  await runAction(async () => {
    const actor = await requireSchoolActor("team:manage");
    await withTenant(actor.schoolId, (tx) => changeUserRole(tx, userPrincipal(actor), str(fd, "userId"), str(fd, "role") === "school_admin" ? "school_admin" : "instructor"));
  }, { back: "/admin/team", okMessage: "Role changed. They need to sign in again." });
}

const ROLE_LABEL: Record<string, string> = { school_owner: "Owner", school_admin: "Office admin", instructor: "Instructor" };

export default async function TeamPage({ searchParams }: { searchParams: SearchParams }) {
  const q = await sp(searchParams);
  const actor = await requireSchoolPage("team:manage");
  const [team, school] = await Promise.all([withTenant(actor.schoolId, (tx) => listTeam(tx)), schoolHeader(actor.schoolId)]);
  return (
    <>
      <h1>Team and sign-in access</h1>
      <Flash searchParams={q} />
      <p className="muted">
        Office admins manage students, lessons and payments. Instructors see only their own calendar and the students they teach.
        Only the owner changes settings, prices and this page. Disabling an account signs the person out everywhere; their history is kept.
      </p>
      <div className="card table-wrap">
        <table>
          <thead><tr><th>Person</th><th>Role</th><th>Status</th><th>Last sign-in</th><th>Actions</th></tr></thead>
          <tbody>
            {team.map((m) => (
              <tr key={m.id}>
                <td>{m.name ?? "—"}<br /><span className="small muted">{m.email}</span></td>
                <td>{ROLE_LABEL[m.role] ?? m.role}{m.instructor_id && m.role !== "instructor" ? <span className="small muted"> · also teaches</span> : null}</td>
                <td><Badge value={m.status === "disabled" ? "cancelled" : m.status === "invited" ? "pending" : "active"} label={m.status} /></td>
                <td className="small">{m.last_login_at ? formatDateTime(m.last_login_at, school.timezone) : "never"}</td>
                <td>
                  {m.role !== "school_owner" && m.id !== actor.userId ? (
                    <div className="row" style={{ flexWrap: "wrap", gap: 6 }}>
                      <form action={status}>
                        <input type="hidden" name="userId" value={m.id} />
                        <input type="hidden" name="status" value={m.status === "disabled" ? "active" : "disabled"} />
                        <button type="submit" className={m.status === "disabled" ? "" : "danger"}>{m.status === "disabled" ? "Enable" : "Disable"}</button>
                      </form>
                      {m.role === "school_admin" && m.instructor_id && (
                        <form action={role}><input type="hidden" name="userId" value={m.id} /><input type="hidden" name="role" value="instructor" /><button type="submit">Make instructor only</button></form>
                      )}
                      {m.role === "instructor" && (
                        <form action={role}><input type="hidden" name="userId" value={m.id} /><input type="hidden" name="role" value="school_admin" /><button type="submit">Make office admin</button></form>
                      )}
                    </div>
                  ) : <span className="small muted">—</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <details className="card">
        <summary><strong>Invite an office admin</strong></summary>
        <form action={invite} style={{ marginTop: 12 }}>
          <div className="fields">
            <div className="field"><label htmlFor="name">Name</label><input id="name" name="name" required /></div>
            <div className="field"><label htmlFor="email">E-mail</label><input id="email" name="email" type="email" required /></div>
          </div>
          <button className="primary" type="submit">Send invitation</button>
        </form>
        <p className="small muted">To add an instructor, use the Instructors page.</p>
      </details>
    </>
  );
}
