import { many, one, withTenant } from "@/lib/db";
import { encryptSecret } from "@/lib/crypto";
import { Flash, sp, type SearchParams } from "@/components/ui";
import { requireSchoolActor, requireSchoolPage } from "@/server/auth/session";
import { userPrincipal } from "@/server/principal";
import { loadSchoolContext } from "@/server/scheduling/loader";
import { updateSchoolProfileAndSettings } from "@/server/services/schools";
import { audit } from "@/server/services/audit";
import { bool, num, optStr, runAction, str } from "@/server/web";

const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

async function saveSettings(fd: FormData) {
  "use server";
  await runAction(async () => {
    const actor = await requireSchoolActor("school:manage_settings");
    const euros = (k: string) => { const n = num(fd, k); return n === undefined ? undefined : Math.round(n * 100); };
    await withTenant(actor.schoolId, async (tx) => {
      await updateSchoolProfileAndSettings(tx, userPrincipal(actor), {
        school: { name: optStr(fd, "name"), address: optStr(fd, "address"), phone: optStr(fd, "phone"), email: optStr(fd, "email"), timezone: optStr(fd, "timezone") },
        settings: {
          min_reschedule_notice_hours: num(fd, "min_reschedule_notice_hours"),
          min_cancellation_notice_hours: num(fd, "min_cancellation_notice_hours"),
          late_cancellation_fee_cents: euros("late_cancellation_fee"),
          min_booking_lead_hours: num(fd, "min_booking_lead_hours"),
          booking_horizon_days: num(fd, "booking_horizon_days"),
          default_lesson_minutes: num(fd, "default_lesson_minutes"),
          default_lesson_price_cents: euros("default_lesson_price"),
          slot_granularity_minutes: num(fd, "slot_granularity_minutes"),
          buffer_minutes: num(fd, "buffer_minutes"),
          payment_due_days: num(fd, "payment_due_days"),
          reminder_hours_before: num(fd, "reminder_hours_before"),
          auto_payment_request: bool(fd, "auto_payment_request"),
          reschedule_requires_approval: bool(fd, "reschedule_requires_approval"),
          ai_agent_enabled: bool(fd, "ai_agent_enabled"),
          ai_agent_can_book: bool(fd, "ai_agent_can_book"),
          school_info_for_agent: str(fd, "school_info_for_agent"),
        },
      });
      // Opening hours: replace all rows.
      await tx.query(`DELETE FROM school_opening_hours`);
      for (let d = 1; d <= 7; d++) {
        const open = str(fd, `open_${d}`);
        const close = str(fd, `close_${d}`);
        if (open && close) await tx.query(`INSERT INTO school_opening_hours (school_id, weekday, opens_at, closes_at) VALUES ($1,$2,$3,$4)`, [actor.schoolId, d, open, close]);
      }
    });
  }, { back: "/admin/settings", okMessage: "Settings saved" });
}

async function saveLevel(fd: FormData) {
  "use server";
  await runAction(async () => {
    const actor = await requireSchoolActor("school:manage_settings");
    await withTenant(actor.schoolId, async (tx) => {
      const id = str(fd, "levelId");
      if (id) {
        await tx.query(`UPDATE level_definitions SET name = $2, description = $3 WHERE id = $1`, [id, str(fd, "name"), str(fd, "description")]);
      } else {
        await tx.query(
          `INSERT INTO level_definitions (school_id, position, name, description) VALUES ($1, (SELECT COALESCE(max(position),0)+1 FROM level_definitions), $2, $3)`,
          [actor.schoolId, str(fd, "name"), str(fd, "description")],
        );
      }
      const newSkill = str(fd, "newSkill");
      if (id && newSkill) await tx.query(`INSERT INTO skills (school_id, level_id, position, name) VALUES ($1,$2,(SELECT COALESCE(max(position),0)+1 FROM skills WHERE level_id = $2),$3)`, [actor.schoolId, id, newSkill]);
      await audit(tx, userPrincipal(actor), "levels.updated", "level", id || null);
    });
  }, { back: "/admin/settings#levels", okMessage: "Level saved" });
}

async function saveIntegrations(fd: FormData) {
  "use server";
  await runAction(async () => {
    const actor = await requireSchoolActor("school:manage_integrations");
    await withTenant(actor.schoolId, async (tx) => {
      const phoneNumberId = str(fd, "phone_number_id");
      const token = str(fd, "access_token");
      if (phoneNumberId) {
        await tx.query(
          `INSERT INTO whatsapp_accounts (school_id, phone_number_id, waba_id, display_phone_number, access_token_encrypted)
           VALUES ($1,$2,$3,$4,$5)
           ON CONFLICT (school_id) DO UPDATE SET phone_number_id = EXCLUDED.phone_number_id, waba_id = EXCLUDED.waba_id,
             display_phone_number = EXCLUDED.display_phone_number,
             access_token_encrypted = CASE WHEN $6 THEN EXCLUDED.access_token_encrypted ELSE whatsapp_accounts.access_token_encrypted END,
             status = 'active'`,
          [actor.schoolId, phoneNumberId, str(fd, "waba_id"), str(fd, "display_phone_number"), token ? encryptSecret(token) : "", Boolean(token)],
        );
      }
      const stripeAccount = str(fd, "stripe_account_id");
      if (stripeAccount) {
        await tx.query(
          `INSERT INTO school_payment_accounts (school_id, provider, provider_account_id, status) VALUES ($1,'stripe',$2,'active')
           ON CONFLICT (school_id, provider) DO UPDATE SET provider_account_id = EXCLUDED.provider_account_id, status = 'active'`,
          [actor.schoolId, stripeAccount],
        );
      }
      await audit(tx, userPrincipal(actor), "integrations.updated", "school", actor.schoolId, { whatsapp: Boolean(phoneNumberId), stripe: Boolean(stripeAccount) });
    });
  }, { back: "/admin/settings#integrations", okMessage: "Integrations saved" });
}

export default async function SettingsPage({ searchParams }: { searchParams: SearchParams }) {
  const q = await sp(searchParams);
  const actor = await requireSchoolPage("school:manage_settings");
  const d = await withTenant(actor.schoolId, async (tx) => ({
    school: (await one<{ name: string; address: string | null; phone: string | null; email: string | null; timezone: string; currency: string; slug: string }>(tx, `SELECT * FROM schools WHERE id = $1`, [actor.schoolId]))!,
    ctx: await loadSchoolContext(tx, actor.schoolId),
    hours: await many<{ weekday: number; opens: string; closes: string }>(tx, `SELECT weekday, to_char(opens_at,'HH24:MI') AS opens, to_char(closes_at,'HH24:MI') AS closes FROM school_opening_hours`),
    levels: await many<{ id: string; position: number; name: string; description: string | null; skills: string[] | null }>(
      tx,
      `SELECT ld.id, ld.position, ld.name, ld.description, array_agg(sk.name ORDER BY sk.position) FILTER (WHERE sk.id IS NOT NULL) AS skills
         FROM level_definitions ld LEFT JOIN skills sk ON sk.level_id = ld.id GROUP BY ld.id ORDER BY ld.position`,
    ),
    wa: await one<{ phone_number_id: string; waba_id: string; display_phone_number: string }>(tx, `SELECT phone_number_id, waba_id, display_phone_number FROM whatsapp_accounts`),
    stripe: await one<{ provider_account_id: string }>(tx, `SELECT provider_account_id FROM school_payment_accounts WHERE provider = 'stripe'`),
  }));
  const s = d.ctx.settings;
  const cents = (c: number) => (c / 100).toFixed(2);
  const numField = (name: keyof typeof s, label: string, extra: Record<string, number> = {}) => (
    <div className="field"><label htmlFor={name}>{label}</label><input id={name} name={name} type="number" defaultValue={Number(s[name])} {...extra} /></div>
  );

  return (
    <>
      <h1>Settings</h1>
      <Flash searchParams={q} />
      <form action={saveSettings}>
        <section className="card">
          <h2>School</h2>
          <p className="small muted">School ID for login: <code>{d.school.slug}</code> · currency {d.school.currency}</p>
          <div className="fields">
            <div className="field"><label htmlFor="name">Name</label><input id="name" name="name" defaultValue={d.school.name} /></div>
            <div className="field"><label htmlFor="timezone">Timezone (IANA)</label><input id="timezone" name="timezone" defaultValue={d.school.timezone} /></div>
            <div className="field"><label htmlFor="address">Address</label><input id="address" name="address" defaultValue={d.school.address ?? ""} /></div>
            <div className="field"><label htmlFor="phone">Phone</label><input id="phone" name="phone" defaultValue={d.school.phone ?? ""} /></div>
            <div className="field"><label htmlFor="email">E-mail</label><input id="email" name="email" type="email" defaultValue={d.school.email ?? ""} /></div>
          </div>
        </section>
        <section className="card">
          <h2>Opening hours</h2>
          {DAYS.map((day, i) => {
            const h = d.hours.find((x) => x.weekday === i + 1);
            return (
              <div key={day} className="row" style={{ marginBottom: 6 }}>
                <span style={{ width: 40 }}>{day}</span>
                <input type="time" name={`open_${i + 1}`} defaultValue={h?.opens ?? ""} aria-label={`${day} opens`} style={{ width: 130 }} />
                <span>–</span>
                <input type="time" name={`close_${i + 1}`} defaultValue={h?.closes ?? ""} aria-label={`${day} closes`} style={{ width: 130 }} />
              </div>
            );
          })}
        </section>
        <section className="card">
          <h2>Lessons &amp; policies</h2>
          <div className="fields">
            {numField("default_lesson_minutes", "Default lesson length (min)", { min: 15, step: 15 })}
            <div className="field"><label htmlFor="default_lesson_price">Price per default lesson</label><input id="default_lesson_price" name="default_lesson_price" type="number" step="0.01" defaultValue={cents(s.default_lesson_price_cents)} /></div>
            {numField("min_reschedule_notice_hours", "Min. reschedule notice (hours)")}
            {numField("min_cancellation_notice_hours", "Min. cancellation notice (hours)")}
            <div className="field"><label htmlFor="late_cancellation_fee">Late cancellation fee</label><input id="late_cancellation_fee" name="late_cancellation_fee" type="number" step="0.01" defaultValue={cents(s.late_cancellation_fee_cents)} /></div>
            {numField("min_booking_lead_hours", "Min. booking lead time (hours)")}
            {numField("booking_horizon_days", "Bookable up to (days ahead)")}
            {numField("slot_granularity_minutes", "Slot start every (min)")}
            {numField("buffer_minutes", "Buffer between lessons (min)")}
            {numField("payment_due_days", "Payment due after (days)")}
            {numField("reminder_hours_before", "Reminder e-mail (hours before)")}
          </div>
          <label className="check"><input type="checkbox" name="auto_payment_request" defaultChecked={s.auto_payment_request} /> Send a payment request automatically when a lesson is completed</label>
          <label className="check"><input type="checkbox" name="reschedule_requires_approval" defaultChecked={s.reschedule_requires_approval} /> Student reschedules need approval</label>
        </section>
        <section className="card">
          <h2>WhatsApp assistant</h2>
          <label className="check"><input type="checkbox" name="ai_agent_enabled" defaultChecked={s.ai_agent_enabled} /> AI assistant answers WhatsApp messages</label>
          <label className="check"><input type="checkbox" name="ai_agent_can_book" defaultChecked={s.ai_agent_can_book} /> Assistant may book lessons</label>
          <div className="field" style={{ marginTop: 8 }}>
            <label htmlFor="school_info_for_agent">Information the assistant may share (packages, exam fees, pick-up points, FAQ)</label>
            <textarea id="school_info_for_agent" name="school_info_for_agent" rows={6} defaultValue={s.school_info_for_agent ?? ""} />
          </div>
        </section>
        <button className="primary" style={{ marginBottom: 24 }}>Save settings</button>
      </form>

      <section className="card" id="levels">
        <h2>Levels &amp; skills</h2>
        {d.levels.map((l) => (
          <form key={l.id} action={saveLevel} style={{ borderTop: "1px solid var(--border)", paddingTop: 8, marginTop: 8 }}>
            <input type="hidden" name="levelId" value={l.id} />
            <div className="fields">
              <div className="field"><label>Level {l.position}</label><input name="name" defaultValue={l.name} aria-label={`Level ${l.position} name`} /></div>
              <div className="field"><label>Description</label><input name="description" defaultValue={l.description ?? ""} aria-label="Description" /></div>
            </div>
            <p className="small muted">Skills: {(l.skills ?? []).join(", ") || "none"}</p>
            <div className="row"><input name="newSkill" placeholder="Add a skill" style={{ maxWidth: 260 }} aria-label="New skill" /><button>Save level</button></div>
          </form>
        ))}
        <form action={saveLevel} className="row" style={{ marginTop: 12 }}>
          <input name="name" placeholder="New level name" required style={{ maxWidth: 260 }} aria-label="New level name" />
          <input name="description" placeholder="Description" style={{ maxWidth: 260 }} aria-label="New level description" />
          <button>Add level</button>
        </form>
      </section>

      {actor.role === "school_owner" && (
        <form action={saveIntegrations} className="card" id="integrations">
          <h2>Integrations</h2>
          <h3>WhatsApp Business (Meta Cloud API)</h3>
          <p className="small muted">Point the Meta app webhook to <code>/api/webhooks/whatsapp</code>. The access token is stored encrypted.</p>
          <div className="fields">
            <div className="field"><label htmlFor="phone_number_id">Phone number ID</label><input id="phone_number_id" name="phone_number_id" defaultValue={d.wa?.phone_number_id ?? ""} /></div>
            <div className="field"><label htmlFor="waba_id">WhatsApp Business Account ID</label><input id="waba_id" name="waba_id" defaultValue={d.wa?.waba_id ?? ""} /></div>
            <div className="field"><label htmlFor="display_phone_number">Display number</label><input id="display_phone_number" name="display_phone_number" defaultValue={d.wa?.display_phone_number ?? ""} /></div>
            <div className="field"><label htmlFor="access_token">Access token {d.wa && "(leave empty to keep)"}</label><input id="access_token" name="access_token" type="password" autoComplete="off" /></div>
          </div>
          <h3>Stripe</h3>
          <div className="field"><label htmlFor="stripe_account_id">Stripe Connect account ID (acct_…), so payments go to your account</label><input id="stripe_account_id" name="stripe_account_id" defaultValue={d.stripe?.provider_account_id ?? ""} /></div>
          <button className="primary">Save integrations</button>
        </form>
      )}
    </>
  );
}
