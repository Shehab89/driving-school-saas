import { Shell } from "@/components/ui";
import { formatDateTime } from "@/lib/time";
import { requirePage } from "@/server/auth/session";
import { platformAuditLog } from "@/server/services/support";

/** Everything platform admins did, newest first (school creation, status and plan changes, support views). */
export default async function PlatformAuditPage() {
  const actor = await requirePage("platform:view_stats");
  const rows = await platformAuditLog();
  return (
    <Shell role={actor.role} title="Platform admin">
      <h1>Platform audit log</h1>
      <div className="card table-wrap">
        <table>
          <thead><tr><th>When</th><th>Admin</th><th>Action</th><th>School</th><th>Details</th></tr></thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i}>
                <td className="small">{formatDateTime(r.created_at, "Europe/Amsterdam")}</td>
                <td className="small">{r.admin_email}</td>
                <td>{r.action}</td>
                <td>{r.school_name ?? "—"}</td>
                <td className="small"><code>{r.changes ? JSON.stringify(r.changes) : ""}</code></td>
              </tr>
            ))}
          </tbody>
        </table>
        {rows.length === 0 && <p className="muted">No platform actions yet.</p>}
      </div>
    </Shell>
  );
}
