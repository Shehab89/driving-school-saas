import Link from "next/link";
import { notFound } from "next/navigation";
import { Badge, Flash, Shell, sp, type SearchParams } from "@/components/ui";
import { formatDateTime } from "@/lib/time";
import { NotFoundError } from "@/lib/errors";
import { requireActor, requirePage } from "@/server/auth/session";
import { platformSchoolDetail, sendOwnerAccessLink } from "@/server/services/support";
import { deliverNotifications } from "@/server/jobs";
import { runAction } from "@/server/web";
import { after } from "next/server";

async function ownerLink(schoolId: string) {
  "use server";
  let kind = "";
  await runAction(async () => {
    const actor = await requireActor("platform:manage_schools");
    kind = await sendOwnerAccessLink(schoolId, actor.userId);
    after(() => deliverNotifications(10).catch(() => undefined));
  }, { back: `/platform/schools/${schoolId}`, okMessage: () => (kind === "invite" ? "A new invitation was sent to the owner" : "A password reset link was sent to the owner") });
}

export default async function PlatformSchoolPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: SearchParams }) {
  const { id } = await params;
  const q = await sp(searchParams);
  const actor = await requirePage("platform:view_stats");
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  let d;
  try {
    d = await platformSchoolDetail(id, actor.userId);
  } catch (err) {
    if (err instanceof NotFoundError) notFound();
    throw err;
  }
  const fmt = (x: Date | null) => (x ? formatDateTime(x, d.school.timezone) : "—");
  const u = d.usage;
  return (
    <Shell role={actor.role} title="Platform admin">
      <p><Link href="/platform">← All schools</Link></p>
      <h1>{d.school.name} <Badge value={d.school.status === "active" ? "active" : d.school.status === "suspended" ? "overdue" : "pending"} label={d.school.status} /></h1>
      <Flash searchParams={q} />
      <div className="grid three">
        <div className="card stat"><div className="value">{u.students}{u.max_active_students ? ` / ${u.max_active_students}` : ""}</div><div className="label">Active students (plan limit)</div></div>
        <div className="card stat"><div className="value">{u.instructors}{u.max_instructors ? ` / ${u.max_instructors}` : ""}</div><div className="label">Active instructors (plan limit)</div></div>
        <div className="card stat"><div className="value">{u.lessons_30d}</div><div className="label">Lessons completed, last 30 days · {u.upcoming} upcoming</div></div>
      </div>
      <div className="card">
        <dl className="kv">
          <dt>School ID</dt><dd>{d.school.slug}</dd>
          <dt>Plan</dt><dd>{u.plan ?? "none"} ({u.sub_status ?? "no subscription"}){u.trial_ends_at ? ` · trial until ${fmt(u.trial_ends_at)}` : ""}</dd>
          <dt>Contact</dt><dd>{d.school.email ?? "—"} · {d.school.phone ?? "—"}</dd>
          <dt>Vehicles</dt><dd>{u.vehicles}</dd>
          <dt>Failed e-mails (7 days)</dt><dd>{u.failed_notifications_7d}</dd>
          <dt>WhatsApp chats waiting for staff</dt><dd>{u.whatsapp_handoffs}</dd>
          <dt>Created</dt><dd>{fmt(d.school.created_at)}</dd>
        </dl>
      </div>
      <div className="card">
        <h2>Owner account</h2>
        {d.owners.map((o) => (
          <p key={o.id}>{o.email} · <Badge value={o.status === "active" ? "active" : "pending"} label={o.status} /> · last sign-in {fmt(o.last_login_at)}</p>
        ))}
        <form action={ownerLink.bind(null, d.school.id)}>
          <button type="submit">Send the owner a sign-in recovery link</button>
        </form>
        <p className="small muted">The link goes only to the owner&apos;s own e-mail address. This action is recorded in the school&apos;s audit log.</p>
      </div>
      <div className="card">
        <h2>Support access</h2>
        {!d.grant ? (
          <p className="muted">The owner has not granted support access. Only the aggregates above are shown. Ask the owner to grant access under Support in their portal.</p>
        ) : (
          <>
            <p>Access granted until <strong>{fmt(d.grant.expires_at)}</strong>. Reason: {d.grant.reason}. This view was recorded in the school&apos;s audit log.</p>
            <h3>Team</h3>
            <table><tbody>{d.support!.team.map((m, i) => <tr key={i}><td>{m.email}</td><td>{m.role}</td><td>{m.status}</td><td className="small">{fmt(m.last_login_at)}</td></tr>)}</tbody></table>
            <h3>Failed e-mails</h3>
            {d.support!.failedNotifications.length === 0 ? <p className="muted">None.</p> : (
              <table><tbody>{d.support!.failedNotifications.map((n, i) => <tr key={i}><td className="small">{fmt(n.created_at)}</td><td>{n.type}</td><td className="small">{n.last_error}</td><td>{n.attempts}</td></tr>)}</tbody></table>
            )}
            <h3>Recent activity</h3>
            <table><tbody>{d.support!.auditTrail.map((a, i) => <tr key={i}><td className="small">{fmt(a.created_at)}</td><td>{a.action}</td><td>{a.entity_type}</td><td>{a.actor_type}</td></tr>)}</tbody></table>
            <h3>Settings</h3>
            <pre className="small" style={{ whiteSpace: "pre-wrap" }}>{JSON.stringify(d.support!.settings, null, 2)}</pre>
          </>
        )}
      </div>
    </Shell>
  );
}
