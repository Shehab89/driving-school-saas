import Link from "next/link";
import { many, one, withTenant } from "@/lib/db";
import { can } from "@/lib/rbac";
import { formatDateTime } from "@/lib/time";
import { Badge, Flash, sp, type SearchParams } from "@/components/ui";
import { requireSchoolActor, requireSchoolPage } from "@/server/auth/session";
import { OVERRIDABLE_TYPES } from "@/server/email/templates";
import { userPrincipal } from "@/server/principal";
import { WHATSAPP_TEMPLATE_PARAMS } from "@/server/services/notification-prefs";
import { recentNotifications, saveTemplateOverride, saveWhatsAppTemplates } from "@/server/services/notification-settings";
import { schoolHeader } from "@/server/school";
import { runAction, str } from "@/server/web";

const label = (type: string) => type.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());

async function saveWording(fd: FormData) {
  "use server";
  await runAction(async () => {
    const actor = await requireSchoolActor("school:manage_settings");
    await withTenant(actor.schoolId, (tx) => saveTemplateOverride(tx, userPrincipal(actor), str(fd, "type"), str(fd, "subject"), str(fd, "intro")));
  }, { back: "/admin/notifications", okMessage: "Wording saved" });
}

async function saveTemplates(fd: FormData) {
  "use server";
  await runAction(async () => {
    const actor = await requireSchoolActor("school:manage_settings");
    const map = Object.fromEntries(Object.keys(WHATSAPP_TEMPLATE_PARAMS).map((t) => [t, { name: str(fd, `name_${t}`), language: str(fd, `lang_${t}`) }]));
    await withTenant(actor.schoolId, (tx) => saveWhatsAppTemplates(tx, userPrincipal(actor), map));
  }, { back: "/admin/notifications", okMessage: "WhatsApp templates saved" });
}

export default async function NotificationsPage({ searchParams }: { searchParams: SearchParams }) {
  const q = await sp(searchParams);
  const actor = await requireSchoolPage("students:read_all");
  const owner = can(actor.role, "school:manage_settings");
  const school = await schoolHeader(actor.schoolId);
  const filter = q.show === "problems" ? "problems" : "all";
  const d = await withTenant(actor.schoolId, async (tx) => ({
    log: await recentNotifications(tx, filter),
    overrides: await many<{ type: string; subject: string | null; intro: string | null }>(tx, `SELECT type, subject, intro FROM notification_template_overrides`),
    wa: await one<{ templates: Record<string, { name: string; language: string }> }>(tx, `SELECT templates FROM whatsapp_accounts WHERE status = 'active'`),
  }));
  return (
    <>
      <h1>Messages</h1>
      <Flash searchParams={q} />

      <section className="card">
        <div className="spread">
          <h2>Recent messages</h2>
          <div className="seg">
            <Link href="/admin/notifications" className={filter === "all" ? "active" : ""}>All</Link>
            <Link href="/admin/notifications?show=problems" className={filter === "problems" ? "active" : ""}>Problems</Link>
          </div>
        </div>
        <div className="table-wrap">
          <table>
            <thead><tr><th>When</th><th>Message</th><th>To</th><th>Status</th><th>Delivery</th></tr></thead>
            <tbody>
              {d.log.length === 0 && <tr><td colSpan={5} className="muted">Nothing here.</td></tr>}
              {d.log.map((n) => (
                <tr key={n.id}>
                  <td className="small">{formatDateTime(n.created_at, school.timezone)}</td>
                  <td>{label(n.type)} <span className="muted small">· {n.channel}</span></td>
                  <td className="small" dir="ltr">{n.to_address}</td>
                  <td><Badge value={n.status === "sent" ? "completed" : n.status === "queued" || n.status === "sending" ? "pending" : "overdue"} label={n.status} />{n.last_error && <div className="small muted">{n.last_error.slice(0, 120)}</div>}</td>
                  <td>{n.delivery_status ? <Badge value={["delivered", "read"].includes(n.delivery_status) ? "completed" : n.delivery_status === "delayed" ? "pending" : "overdue"} label={n.delivery_status} /> : <span className="muted small">–</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="small muted">
          &quot;Suppressed&quot; means the message was deliberately not sent: the student switched it off, withdrew WhatsApp consent, or the address bounced or reported spam earlier.
          Delivery shows what the e-mail or WhatsApp provider reported afterwards (needs the provider webhooks to be configured).
        </p>
      </section>

      {owner && (
        <section className="card">
          <h2>E-mail wording</h2>
          <p className="small muted">Change the subject or the opening paragraph of an e-mail. Lesson details, amounts and payment links are always added by the system. You can use {"{name}"} and {"{school}"}.</p>
          {OVERRIDABLE_TYPES.map((type) => {
            const o = d.overrides.find((x) => x.type === type);
            return (
              <details key={type} style={{ borderTop: "1px solid var(--border)", padding: "8px 0" }}>
                <summary>{label(type)} {o && <Badge value="completed" label="customised" />}</summary>
                <form action={saveWording} style={{ marginTop: 8 }}>
                  <input type="hidden" name="type" value={type} />
                  <div className="field"><label htmlFor={`s_${type}`}>Subject</label><input id={`s_${type}`} name="subject" maxLength={200} defaultValue={o?.subject ?? ""} placeholder="Standard subject" /></div>
                  <div className="field"><label htmlFor={`i_${type}`}>Opening paragraph</label><textarea id={`i_${type}`} name="intro" maxLength={1000} rows={3} defaultValue={o?.intro ?? ""} placeholder="Standard text" /></div>
                  <button type="submit">Save</button> <span className="small muted">Leave both empty to go back to the standard wording.</span>
                </form>
              </details>
            );
          })}
        </section>
      )}

      {owner && (
        <section className="card">
          <h2>WhatsApp templates</h2>
          {!d.wa ? (
            <p className="muted">Connect a WhatsApp Business number in <Link href="/admin/settings">Settings</Link> first.</p>
          ) : (
            <form action={saveTemplates}>
              <p className="small muted">
                Messages the school starts on WhatsApp (reminders, changes) must use a template approved by Meta in your WhatsApp Manager.
                Create each template with the parameters listed, then enter its exact name and language here. Messages without a template are sent by e-mail.
                Students only get WhatsApp messages after agreeing in the student app or by sending START, and can stop with STOP.
              </p>
              <table>
                <thead><tr><th>Message</th><th>Template parameters</th><th>Template name</th><th>Language</th></tr></thead>
                <tbody>
                  {Object.entries(WHATSAPP_TEMPLATE_PARAMS).map(([type, params]) => (
                    <tr key={type}>
                      <td>{label(type)}</td>
                      <td className="small">{params!.map((p, i) => `{{${i + 1}}} ${p}`).join(", ")}</td>
                      <td><input name={`name_${type}`} defaultValue={d.wa!.templates[type]?.name ?? ""} placeholder="not sent on WhatsApp" aria-label={`${label(type)} template name`} /></td>
                      <td><input name={`lang_${type}`} defaultValue={d.wa!.templates[type]?.language ?? "nl"} style={{ width: 80 }} aria-label={`${label(type)} language`} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <button className="primary" type="submit">Save templates</button>
            </form>
          )}
        </section>
      )}
    </>
  );
}
