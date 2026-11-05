import Link from "next/link";
import { many, one, withTenant } from "@/lib/db";
import { can } from "@/lib/rbac";
import { Badge, Flash, sp, type SearchParams } from "@/components/ui";
import { requireSchoolActor, requireSchoolPage } from "@/server/auth/session";
import { OVERRIDABLE_TYPES } from "@/server/email/templates";
import { userPrincipal } from "@/server/principal";
import { WHATSAPP_TEMPLATE_PARAMS } from "@/server/services/notification-prefs";
import { recentNotifications, saveTemplateOverride, saveWhatsAppTemplates } from "@/server/services/notification-settings";
import { schoolI18n } from "@/server/school";
import { getPt } from "@/i18n/server";
import { MESSAGE_TYPE, SEND_STATUS } from "./labels";
import { runAction, str } from "@/server/web";


async function saveWording(fd: FormData) {
  "use server";
  const pt = await getPt();
  await runAction(async () => {
    const actor = await requireSchoolActor("school:manage_settings");
    await withTenant(actor.schoolId, (tx) => saveTemplateOverride(tx, userPrincipal(actor), str(fd, "type"), str(fd, "subject"), str(fd, "intro")));
  }, { back: "/admin/notifications", okMessage: pt("Wording saved") });
}

async function saveTemplates(fd: FormData) {
  "use server";
  const pt = await getPt();
  await runAction(async () => {
    const actor = await requireSchoolActor("school:manage_settings");
    const map = Object.fromEntries(Object.keys(WHATSAPP_TEMPLATE_PARAMS).map((t) => [t, { name: str(fd, `name_${t}`), language: str(fd, `lang_${t}`) }]));
    await withTenant(actor.schoolId, (tx) => saveWhatsAppTemplates(tx, userPrincipal(actor), map));
  }, { back: "/admin/notifications", okMessage: pt("WhatsApp templates saved") });
}

export default async function NotificationsPage({ searchParams }: { searchParams: SearchParams }) {
  const q = await sp(searchParams);
  const actor = await requireSchoolPage("students:read_all");
  const owner = can(actor.role, "school:manage_settings");
  const { f, pt } = await schoolI18n(actor.schoolId);
  const label = (type: string) => pt(MESSAGE_TYPE[type] ?? type.replace(/_/g, " "));
  const st = (v: string) => pt(SEND_STATUS[v] ?? v);
  const filter = q.show === "problems" ? "problems" : "all";
  const d = await withTenant(actor.schoolId, async (tx) => ({
    log: await recentNotifications(tx, filter),
    overrides: await many<{ type: string; subject: string | null; intro: string | null }>(tx, `SELECT type, subject, intro FROM notification_template_overrides`),
    wa: await one<{ templates: Record<string, { name: string; language: string }> }>(tx, `SELECT templates FROM whatsapp_accounts WHERE status = 'active'`),
  }));
  return (
    <>
      <div className="page-title">
        <div>
          <h1>{pt("Sent messages")}</h1>
          <p>{pt("Every e-mail and WhatsApp message the system sent for your school, and whether it arrived.")}</p>
        </div>
      </div>
      <Flash searchParams={q} />

      <section className="card table-card">
        <div className="spread">
          <h2>{pt("Recent messages")}</h2>
          <div className="seg">
            <Link href="/admin/notifications" className={filter === "all" ? "active" : ""}>{pt("All")}</Link>
            <Link href="/admin/notifications?show=problems" className={filter === "problems" ? "active" : ""}>{pt("Problems")}</Link>
          </div>
        </div>
        {d.log.length === 0 ? <p className="empty">{filter === "problems" ? pt("No problems. Every message was delivered.") : pt("Nothing here.")}</p> : (
        <div className="table-wrap">
          <table className="stack-table">
            <thead><tr><th>{pt("When")}</th><th>{pt("Message")}</th><th>{pt("To")}</th><th>{pt("Status")}</th><th>{pt("Delivery")}</th></tr></thead>
            <tbody>
              {d.log.map((n) => (
                <tr key={n.id}>
                  <td data-label={pt("When")} className="small">{f.dateTime(n.created_at)}</td>
                  <td data-label={pt("Message")}>{label(n.type)} <span className="muted small">· {n.channel === "whatsapp" ? "WhatsApp" : pt("E-mail")}</span></td>
                  <td data-label={pt("To")} className="small" dir="ltr">{n.to_address}</td>
                  <td data-label={pt("Status")}><Badge value={n.status === "sent" ? "completed" : n.status === "queued" || n.status === "sending" ? "pending" : "overdue"} label={st(n.status)} />{n.last_error && <div className="small muted">{n.last_error.slice(0, 120)}</div>}</td>
                  <td data-label={pt("Delivery")}>{n.delivery_status ? <Badge value={["delivered", "read"].includes(n.delivery_status) ? "completed" : n.delivery_status === "delayed" ? "pending" : "overdue"} label={st(n.delivery_status)} /> : <span className="muted small">–</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        )}
        <p className="small muted" style={{ padding: "0 18px 14px" }}>
          {pt("“Not sent (on purpose)” means the student switched this message off, withdrew WhatsApp consent, or the address bounced or reported spam earlier. Delivery shows what the e-mail or WhatsApp provider reported afterwards.")}
        </p>
      </section>

      {owner && (
        <section className="card">
          <h2>{pt("E-mail wording")}</h2>
          <p className="small muted">{pt("Change the subject or the opening paragraph of an e-mail. Lesson details, amounts and payment links are always added automatically. You can use {name} and {school}.", { name: "{name}", school: "{school}" })}</p>
          {OVERRIDABLE_TYPES.map((type) => {
            const o = d.overrides.find((x) => x.type === type);
            return (
              <details key={type} className="setting-row">
                <summary>{label(type)} {o && <Badge value="completed" label={pt("customised")} />}</summary>
                <form action={saveWording} style={{ marginTop: 8 }}>
                  <input type="hidden" name="type" value={type} />
                  <div className="field"><label htmlFor={`s_${type}`}>{pt("Subject")}</label><input id={`s_${type}`} name="subject" maxLength={200} defaultValue={o?.subject ?? ""} placeholder={pt("Standard subject")} /></div>
                  <div className="field"><label htmlFor={`i_${type}`}>{pt("Opening paragraph")}</label><textarea id={`i_${type}`} name="intro" maxLength={1000} rows={3} defaultValue={o?.intro ?? ""} placeholder={pt("Standard text")} /></div>
                  <button type="submit" className="sm">{pt("Save")}</button> <span className="small muted">{pt("Leave both empty to go back to the standard wording.")}</span>
                </form>
              </details>
            );
          })}
        </section>
      )}

      {owner && (
        <section className="card">
          <h2>{pt("WhatsApp templates")}</h2>
          {!d.wa ? (
            <p className="muted">{pt("Connect a WhatsApp Business number in Settings first.")} <Link href="/admin/settings#integrations">{pt("Settings")}</Link></p>
          ) : (
            <form action={saveTemplates}>
              <p className="small muted">
                {pt("Messages the school starts on WhatsApp (reminders, changes) must use a template approved by Meta in your WhatsApp Manager. Create each template with the parameters listed, then enter its exact name and language here. Messages without a template are sent by e-mail. Students only get WhatsApp messages after agreeing in the student app or by sending START, and can stop with STOP.")}
              </p>
              <div className="table-wrap">
              <table className="stack-table">
                <thead><tr><th>{pt("Message")}</th><th>{pt("Template parameters")}</th><th>{pt("Template name")}</th><th>{pt("Language")}</th></tr></thead>
                <tbody>
                  {Object.entries(WHATSAPP_TEMPLATE_PARAMS).map(([type, params]) => (
                    <tr key={type}>
                      <td data-label={pt("Message")}>{label(type)}</td>
                      <td data-label={pt("Template parameters")} className="small" dir="ltr">{params!.map((p, i) => `{{${i + 1}}} ${p}`).join(", ")}</td>
                      <td data-label={pt("Template name")}><input name={`name_${type}`} defaultValue={d.wa!.templates[type]?.name ?? ""} placeholder={pt("not sent on WhatsApp")} aria-label={pt("Template name")} dir="ltr" /></td>
                      <td data-label={pt("Language")}><input name={`lang_${type}`} defaultValue={d.wa!.templates[type]?.language ?? "nl"} style={{ width: 80 }} aria-label={pt("Language")} dir="ltr" /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
              </div>
              <button className="primary" type="submit">{pt("Save templates")}</button>
            </form>
          )}
        </section>
      )}
    </>
  );
}
