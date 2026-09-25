import { Badge, Flash, Shell, sp, type SearchParams } from "@/components/ui";
import { formatMoney } from "@/lib/time";
import { requireActor, requirePage } from "@/server/auth/session";
import { createSchool, platformOverview, setSchoolPlan, setSchoolStatus } from "@/server/services/schools";
import { runAction, str } from "@/server/web";
import { after } from "next/server";
import { deliverNotifications } from "@/server/jobs";

async function create(fd: FormData) {
  "use server";
  await runAction(async () => {
    const actor = await requireActor("platform:manage_schools");
    await createSchool(
      {
        name: str(fd, "name"),
        slug: str(fd, "slug"),
        timezone: str(fd, "timezone") || "Europe/Amsterdam",
        currency: str(fd, "currency") || "EUR",
        ownerEmail: str(fd, "ownerEmail"),
        ownerName: str(fd, "ownerName"),
        planCode: str(fd, "plan") || "starter",
      },
      actor.userId,
    );
    after(() => deliverNotifications(10).catch(() => undefined));
  }, { back: "/platform", okMessage: "School created and owner invited" });
}

async function status(fd: FormData) {
  "use server";
  await runAction(async () => {
    const actor = await requireActor("platform:manage_schools");
    await setSchoolStatus(str(fd, "schoolId"), str(fd, "status") as "active", actor.userId);
  }, { back: "/platform" });
}

async function plan(fd: FormData) {
  "use server";
  await runAction(async () => {
    const actor = await requireActor("platform:manage_subscriptions");
    await setSchoolPlan(str(fd, "schoolId"), str(fd, "planId"), str(fd, "subStatus") as "active", actor.userId);
  }, { back: "/platform", okMessage: "Subscription updated" });
}

export default async function PlatformPage({ searchParams }: { searchParams: SearchParams }) {
  const q = await sp(searchParams);
  const actor = await requirePage("platform:view_stats");
  const { schools, totals, plans } = await platformOverview();
  return (
    <Shell role={actor.role} title="Platform admin">
      <h1>Schools</h1>
      <Flash searchParams={q} />
      <div className="grid three">
        <div className="card stat"><div className="value">{totals.schools}</div><div className="label">Active / trial schools</div></div>
        <div className="card stat"><div className="value">{totals.active_students}</div><div className="label">Active students</div></div>
        <div className="card stat"><div className="value">{totals.lessons_30d}</div><div className="label">Lessons completed (30d) · {totals.whatsapp_msgs_30d} WhatsApp msgs</div></div>
      </div>
      <div className="card table-wrap">
        <table>
          <thead><tr><th>School</th><th>Plan</th><th>Students</th><th>Instructors</th><th>Lessons 30d</th><th>Revenue 30d</th><th>Status</th></tr></thead>
          <tbody>
            {schools.map((s) => (
              <tr key={s.id}>
                <td><strong>{s.name}</strong><div className="small muted">{s.slug}</div></td>
                <td>
                  <form action={plan} className="row">
                    <input type="hidden" name="schoolId" value={s.id} />
                    <select name="planId" aria-label="Plan" style={{ width: "auto", minHeight: 32 }} defaultValue={plans.find((p) => p.name === s.plan)?.id}>
                      {plans.map((p) => <option key={p.id} value={p.id}>{p.name} ({formatMoney(p.monthly_price_cents, p.currency)})</option>)}
                    </select>
                    <select name="subStatus" aria-label="Subscription status" defaultValue={s.subscription_status ?? "trialing"} style={{ width: "auto", minHeight: 32 }}>
                      <option>trialing</option><option>active</option><option>past_due</option><option>cancelled</option>
                    </select>
                    <button style={{ minHeight: 32 }}>Set</button>
                  </form>
                </td>
                <td>{s.students}</td>
                <td>{s.instructors}</td>
                <td>{s.lessons_30d}</td>
                <td>{formatMoney(s.revenue_30d_cents, s.currency)}</td>
                <td>
                  <form action={status} className="row">
                    <input type="hidden" name="schoolId" value={s.id} />
                    <Badge value={s.status === "active" ? "active" : s.status === "suspended" ? "overdue" : "pending"} label={s.status} />
                    <select name="status" defaultValue={s.status} aria-label="Status" style={{ width: "auto", minHeight: 32 }}>
                      <option>trial</option><option>active</option><option>suspended</option><option>closed</option>
                    </select>
                    <button style={{ minHeight: 32 }}>Set</button>
                  </form>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <details className="card" open={schools.length === 0}>
        <summary><strong>Create school</strong></summary>
        <form action={create} style={{ marginTop: 12 }}>
          <div className="fields">
            <div className="field"><label htmlFor="name">School name</label><input id="name" name="name" required /></div>
            <div className="field"><label htmlFor="slug">School ID (URL-safe)</label><input id="slug" name="slug" pattern="[a-z0-9][a-z0-9-]+[a-z0-9]" required /></div>
            <div className="field"><label htmlFor="timezone">Timezone</label><input id="timezone" name="timezone" defaultValue="Europe/Amsterdam" /></div>
            <div className="field"><label htmlFor="currency">Currency</label><input id="currency" name="currency" defaultValue="EUR" maxLength={3} /></div>
            <div className="field"><label htmlFor="ownerName">Owner name</label><input id="ownerName" name="ownerName" required /></div>
            <div className="field"><label htmlFor="ownerEmail">Owner e-mail</label><input id="ownerEmail" name="ownerEmail" type="email" required /></div>
            <div className="field"><label htmlFor="plan">Plan</label><select id="plan" name="plan">{plans.map((p) => <option key={p.code} value={p.code}>{p.name}</option>)}</select></div>
          </div>
          <button className="primary">Create school &amp; invite owner</button>
        </form>
      </details>
    </Shell>
  );
}
