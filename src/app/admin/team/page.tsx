import { withTenant } from "@/lib/db";
import { Badge, Flash, sp, type SearchParams } from "@/components/ui";
import { requireSchoolActor, requireSchoolPage } from "@/server/auth/session";
import { userPrincipal } from "@/server/principal";
import { changeUserRole, inviteAdmin, listTeam, setUserStatus } from "@/server/services/team";
import { deliverNotifications } from "@/server/jobs";
import { runAction, str } from "@/server/web";
import { getPt } from "@/i18n/server";
import { ptKey } from "@/i18n/portal";
import { schoolI18n } from "@/server/school";
import { after } from "next/server";

async function invite(fd: FormData) {
  "use server";
  const pt = await getPt();
  await runAction(async () => {
    const actor = await requireSchoolActor("team:manage");
    await withTenant(actor.schoolId, (tx) => inviteAdmin(tx, userPrincipal(actor), { email: str(fd, "email"), name: str(fd, "name") }));
    after(() => deliverNotifications(10).catch(() => undefined));
  }, { back: "/admin/team", okMessage: pt("Invitation sent") });
}

async function status(fd: FormData) {
  "use server";
  const pt = await getPt();
  await runAction(async () => {
    const actor = await requireSchoolActor("team:manage");
    await withTenant(actor.schoolId, (tx) => setUserStatus(tx, userPrincipal(actor), str(fd, "userId"), str(fd, "status") === "disabled" ? "disabled" : "active"));
  }, { back: "/admin/team", okMessage: pt("Account updated. They were signed out everywhere.") });
}

async function role(fd: FormData) {
  "use server";
  const pt = await getPt();
  await runAction(async () => {
    const actor = await requireSchoolActor("team:manage");
    await withTenant(actor.schoolId, (tx) => changeUserRole(tx, userPrincipal(actor), str(fd, "userId"), str(fd, "role") === "school_admin" ? "school_admin" : "instructor"));
  }, { back: "/admin/team", okMessage: pt("Role changed. They need to sign in again.") });
}

const ROLE_LABEL: Record<string, string> = { school_owner: ptKey("Owner"), school_admin: ptKey("Office staff"), instructor: ptKey("Instructor") };
const STATUS_LABEL: Record<string, string> = { active: ptKey("Active"), invited: ptKey("Invited"), disabled: ptKey("Disabled") };

export default async function TeamPage({ searchParams }: { searchParams: SearchParams }) {
  const q = await sp(searchParams);
  const actor = await requireSchoolPage("team:manage");
  const team = await withTenant(actor.schoolId, (tx) => listTeam(tx));
  const { f, pt } = await schoolI18n(actor.schoolId);
  return (
    <>
      <div className="page-title">
        <div>
          <h1>{pt("Team")}</h1>
          <p>{pt("Who can sign in to your school, and what they may do.")}</p>
        </div>
        <div className="actions"><a className="btn primary" href="#invite">{pt("Invite office staff")}</a></div>
      </div>
      <Flash searchParams={q} />
      <div className="grid three role-explain">
        <div className="card"><h3>{pt("Owner")}</h3><p className="small">{pt("Everything, including settings, prices and this page.")}</p></div>
        <div className="card"><h3>{pt("Office staff")}</h3><p className="small">{pt("Students, lessons and payments.")}</p></div>
        <div className="card"><h3>{pt("Instructor")}</h3><p className="small">{pt("Only their own calendar and the students they teach.")}</p></div>
      </div>
      <div className="card table-card">
        <div className="table-wrap">
        <table className="stack-table">
          <thead><tr><th>{pt("Person")}</th><th>{pt("Role")}</th><th>{pt("Status")}</th><th>{pt("Last sign-in")}</th><th>{pt("Actions")}</th></tr></thead>
          <tbody>
            {team.map((m) => (
              <tr key={m.id}>
                <td data-label={pt("Person")}><strong>{m.name ?? "—"}</strong><br /><span className="small muted" dir="ltr">{m.email}</span></td>
                <td data-label={pt("Role")}>{pt(ROLE_LABEL[m.role] ?? m.role)}{m.instructor_id && m.role !== "instructor" ? <span className="small muted"> · {pt("also teaches")}</span> : null}</td>
                <td data-label={pt("Status")}><Badge value={m.status === "disabled" ? "cancelled" : m.status === "invited" ? "pending" : "active"} label={pt(STATUS_LABEL[m.status] ?? m.status)} /></td>
                <td data-label={pt("Last sign-in")} className="small">{m.last_login_at ? f.dateTime(m.last_login_at) : pt("never")}</td>
                <td data-label={pt("Actions")}>
                  {m.role !== "school_owner" && m.id !== actor.userId ? (
                    <div className="row" style={{ flexWrap: "wrap", gap: 6 }}>
                      <form action={status}>
                        <input type="hidden" name="userId" value={m.id} />
                        <input type="hidden" name="status" value={m.status === "disabled" ? "active" : "disabled"} />
                        <button type="submit" className={m.status === "disabled" ? "sm" : "sm danger"}>{m.status === "disabled" ? pt("Allow sign-in again") : pt("Block sign-in")}</button>
                      </form>
                      {m.role === "school_admin" && m.instructor_id && (
                        <form action={role}><input type="hidden" name="userId" value={m.id} /><input type="hidden" name="role" value="instructor" /><button type="submit" className="sm">{pt("Make instructor only")}</button></form>
                      )}
                      {m.role === "instructor" && (
                        <form action={role}><input type="hidden" name="userId" value={m.id} /><input type="hidden" name="role" value="school_admin" /><button type="submit" className="sm">{pt("Make office staff")}</button></form>
                      )}
                    </div>
                  ) : <span className="small muted">—</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        </div>
      </div>
      <p className="small muted">{pt("Blocking an account signs the person out everywhere. Their history is kept.")}</p>
      <details className="card" id="invite">
        <summary>{pt("Invite office staff")}</summary>
        <form action={invite}>
          <div className="fields">
            <div className="field"><label htmlFor="name">{pt("Name")}</label><input id="name" name="name" required /></div>
            <div className="field"><label htmlFor="email">{pt("E-mail")}</label><input id="email" name="email" type="email" dir="ltr" required /></div>
          </div>
          <button className="primary" type="submit">{pt("Send invitation")}</button>
        </form>
        <p className="small muted" style={{ marginTop: 10 }}>{pt("To add an instructor, use the Instructors page.")}</p>
      </details>
    </>
  );
}
