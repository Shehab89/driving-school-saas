import { many, one, withTenant } from "@/lib/db";
import { encryptSecret } from "@/lib/crypto";
import { Flash, sp, type SearchParams } from "@/components/ui";
import { requireSchoolActor, requireSchoolPage } from "@/server/auth/session";
import { userPrincipal } from "@/server/principal";
import { loadSchoolContext } from "@/server/scheduling/loader";
import { updateSchoolProfileAndSettings } from "@/server/services/schools";
import { audit } from "@/server/services/audit";
import { savePriceList, upcomingUnbilledCount } from "@/server/services/pricing";
import { bool, num, optStr, runAction, str } from "@/server/web";
import { getPt } from "@/i18n/server";
import { ptKey } from "@/i18n/portal";
import { schoolI18n } from "@/server/school";


async function saveSettings(fd: FormData) {
  "use server";
  const pt = await getPt();
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
          slot_granularity_minutes: num(fd, "slot_granularity_minutes"),
          buffer_minutes: num(fd, "buffer_minutes"),
          travel_speed_kmh: num(fd, "travel_speed_kmh"),
          payment_due_days: num(fd, "payment_due_days"),
          reminder_hours_before: num(fd, "reminder_hours_before"),
          auto_payment_request: bool(fd, "auto_payment_request"),
          reschedule_requires_approval: bool(fd, "reschedule_requires_approval"),
          ai_agent_enabled: bool(fd, "ai_agent_enabled"),
          ai_agent_can_book: bool(fd, "ai_agent_can_book"),
          student_self_booking: bool(fd, "student_self_booking"),
          max_upcoming_self_bookings: str(fd, "max_upcoming_self_bookings") === "" ? null : num(fd, "max_upcoming_self_bookings"),
          school_info_for_agent: str(fd, "school_info_for_agent"),
          retention_months: str(fd, "retention_months") === "" ? null : num(fd, "retention_months"),
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
  }, { back: "/admin/settings", okMessage: pt("Settings saved") });
}

const TYPES = [
  ["practical", ptKey("Driving lesson")],
  ["exam_prep", ptKey("Exam preparation")],
  ["exam", ptKey("Exam")],
  ["assessment", ptKey("Intake / assessment")],
] as const;

async function savePrices(fd: FormData) {
  "use server";
  const pt = await getPt();
  let updated = 0;
  await runAction(async () => {
    const actor = await requireSchoolActor("pricing:write");
    const euros = (k: string) => { const n = num(fd, k); return n === undefined ? null : Math.round(n * 100); };
    const r = await withTenant(actor.schoolId, (tx) =>
      savePriceList(tx, userPrincipal(actor), {
        defaultPriceCents: euros("default_price") ?? 0,
        typePrices: Object.fromEntries(TYPES.map(([k]) => [k, euros(`type_${k}`)])) as Record<(typeof TYPES)[number][0], number | null>,
        applyToUpcoming: bool(fd, "applyToUpcoming"),
      }),
    );
    updated = r.updated;
  }, { back: "/admin/settings#prices", okMessage: () => (updated ? pt("Prices saved; {count} upcoming lessons updated", { count: updated }) : pt("Prices saved")) });
}

async function saveLevel(fd: FormData) {
  "use server";
  const pt = await getPt();
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
  }, { back: "/admin/settings#levels", okMessage: pt("Level saved") });
}

async function saveIntegrations(fd: FormData) {
  "use server";
  const pt = await getPt();
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
      await audit(tx, userPrincipal(actor), "integrations.updated", "school", actor.schoolId, { whatsapp: Boolean(phoneNumberId) });
    });
  }, { back: "/admin/settings#integrations", okMessage: pt("Connections saved") });
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
    upcoming: await upcomingUnbilledCount(tx),
  }));
  const s = d.ctx.settings;
  const { f, pt } = await schoolI18n(actor.schoolId);
  const owner = actor.role === "school_owner";
  const cents = (c: number) => (c / 100).toFixed(2);
  const numField = (name: keyof typeof s, label: string, hint?: string, extra: Record<string, number> = {}) => (
    <div className="field">
      <label htmlFor={name}>{label}</label>
      <input id={name} name={name} type="number" inputMode="numeric" defaultValue={Number(s[name])} {...extra} />
      {hint && <p className="small muted" style={{ margin: "4px 0 0" }}>{hint}</p>}
    </div>
  );
  const sections: Array<[string, string]> = [
    ["school", pt("School")],
    ["booking", pt("Booking rules")],
    ...(owner ? [["prices", pt("Prices")] as [string, string]] : []),
    ["levels", pt("Levels")],
    ["assistant", pt("WhatsApp assistant")],
    ...(owner ? [["integrations", pt("Connections")] as [string, string]] : []),
    ["privacy", pt("Privacy")],
  ];

  return (
    <>
      <div className="page-title">
        <div>
          <h1>{pt("Settings")}</h1>
          <p>{pt("How your school works: opening hours, booking rules, prices and connections.")}</p>
        </div>
      </div>
      <Flash searchParams={q} />
      <nav className="chips settings-nav" aria-label={pt("Sections")}>
        {sections.map(([id, label]) => <a key={id} className="chip" href={`#${id}`}>{label}</a>)}
      </nav>
      <form action={saveSettings}>
        <section className="card" id="school">
          <h2>{pt("School")}</h2>
          <p className="small muted">{pt("School ID for signing in")}: <code>{d.school.slug}</code> · {pt("currency")} {d.school.currency}</p>
          <div className="fields">
            <div className="field"><label htmlFor="name">{pt("Name")}</label><input id="name" name="name" defaultValue={d.school.name} /></div>
            <div className="field"><label htmlFor="timezone">{pt("Time zone")}</label><input id="timezone" name="timezone" defaultValue={d.school.timezone} dir="ltr" /></div>
            <div className="field"><label htmlFor="address">{pt("Address")}</label><input id="address" name="address" defaultValue={d.school.address ?? ""} /></div>
            <div className="field"><label htmlFor="phone">{pt("Phone")}</label><input id="phone" name="phone" type="tel" dir="ltr" defaultValue={d.school.phone ?? ""} /></div>
            <div className="field"><label htmlFor="email">{pt("E-mail (students' replies go here)")}</label><input id="email" name="email" type="email" dir="ltr" defaultValue={d.school.email ?? ""} /></div>
          </div>
          <h3 style={{ marginTop: 8 }}>{pt("Opening hours")}</h3>
          <p className="small muted">{pt("Leave a day empty when the school is closed.")}</p>
          <div className="hours-grid">
            {[1, 2, 3, 4, 5, 6, 7].map((n) => {
              const h = d.hours.find((x) => x.weekday === n);
              const day = f.weekday(n);
              return (
                <div key={n} className="hours-row">
                  <span>{day}</span>
                  <input type="time" name={`open_${n}`} defaultValue={h?.opens ?? ""} aria-label={pt("{day} opens", { day })} />
                  <span aria-hidden>–</span>
                  <input type="time" name={`close_${n}`} defaultValue={h?.closes ?? ""} aria-label={pt("{day} closes", { day })} />
                </div>
              );
            })}
          </div>
        </section>
        <section className="card" id="booking">
          <h2>{pt("Booking rules")}</h2>
          <label className="switch" style={{ marginBottom: 10 }}>{pt("Students can book lessons themselves in the app")}<input type="checkbox" name="student_self_booking" defaultChecked={s.student_self_booking} /></label>
          <div className="fields">
            <div className="field">
              <label htmlFor="max_upcoming_self_bookings">{pt("Most lessons a student may have booked ahead")}</label>
              <input id="max_upcoming_self_bookings" name="max_upcoming_self_bookings" type="number" min={1} max={50} defaultValue={s.max_upcoming_self_bookings ?? ""} />
              <p className="small muted" style={{ margin: "4px 0 0" }}>{pt("Stops one student from filling an instructor's week. Empty = no limit. You and your staff can always book more.")}</p>
            </div>
            {numField("default_lesson_minutes", pt("Normal lesson length (minutes)"), undefined, { min: 15, step: 15 })}
            {numField("min_booking_lead_hours", pt("Book at least … hours ahead"))}
            {numField("booking_horizon_days", pt("Bookable up to … days ahead"))}
            {numField("min_reschedule_notice_hours", pt("Students can move a lesson up to … hours before"))}
            {numField("min_cancellation_notice_hours", pt("Free cancellation up to … hours before"))}
            <div className="field"><label htmlFor="late_cancellation_fee">{pt("Fee for late cancellation ({currency})", { currency: d.school.currency })}</label><input id="late_cancellation_fee" name="late_cancellation_fee" type="number" inputMode="decimal" step="0.01" defaultValue={cents(s.late_cancellation_fee_cents)} /></div>
            {numField("slot_granularity_minutes", pt("Lessons start every … minutes"))}
            {numField("buffer_minutes", pt("Break between lessons (minutes)"))}
            {numField("travel_speed_kmh", pt("Average speed in town for driving between lessons (km/h)"))}
            {numField("payment_due_days", pt("Payment due after … days"))}
            {numField("reminder_hours_before", pt("Send a reminder … hours before the lesson"))}
          </div>
          <label className="switch" style={{ marginBottom: 10 }}>{pt("Send a payment request automatically when a lesson is finished")}<input type="checkbox" name="auto_payment_request" defaultChecked={s.auto_payment_request} /></label>
          <label className="switch">{pt("Changes by students need my approval")}<input type="checkbox" name="reschedule_requires_approval" defaultChecked={s.reschedule_requires_approval} /></label>
        </section>
        <section className="card" id="assistant">
          <h2>{pt("WhatsApp assistant")}</h2>
          <label className="switch" style={{ marginBottom: 10 }}>{pt("The AI assistant answers WhatsApp messages")}<input type="checkbox" name="ai_agent_enabled" defaultChecked={s.ai_agent_enabled} /></label>
          <label className="switch" style={{ marginBottom: 10 }}>{pt("The assistant may book lessons")}<input type="checkbox" name="ai_agent_can_book" defaultChecked={s.ai_agent_can_book} /></label>
          <div className="field">
            <label htmlFor="school_info_for_agent">{pt("What the assistant may tell people (packages, exam fees, pick-up points, common questions)")}</label>
            <textarea id="school_info_for_agent" name="school_info_for_agent" rows={6} defaultValue={s.school_info_for_agent ?? ""} />
          </div>
        </section>
        <section className="card" id="privacy">
          <h2>{pt("Privacy")}</h2>
          <div className="field">
            <label htmlFor="retention_months">{pt("Erase archived students automatically after … months (12–120; empty = never)")}</label>
            <input id="retention_months" name="retention_months" type="number" min={12} max={120} defaultValue={s.retention_months ?? ""} style={{ maxWidth: 160 }} />
          </div>
          <p className="small muted">{pt("The GDPR says personal data may not be kept longer than needed. Archived students are anonymised after this period (unless they still have open payments). Invoices stay, with the name on the invoice, for the 7 years Dutch tax law requires.")}</p>
        </section>
        <div className="save-bar">
          <button className="primary">{pt("Save settings")}</button>
        </div>
      </form>

      {owner && (
        <form action={savePrices} className="card" id="prices">
          <h2>{pt("Prices")}</h2>
          <p className="muted small">{pt("Prices are for a {minutes}-minute lesson; longer or shorter lessons cost proportionally more or less. Leave a kind empty to use the normal price. You can also change the price of a single lesson on the lesson page.", { minutes: s.default_lesson_minutes })}</p>
          <div className="fields">
            <div className="field">
              <label htmlFor="default_price">{pt("Normal price ({currency})", { currency: d.school.currency })}</label>
              <input id="default_price" name="default_price" type="number" inputMode="decimal" step="0.01" min="0" required defaultValue={cents(s.default_lesson_price_cents)} />
            </div>
            {TYPES.map(([k, label]) => (
              <div className="field" key={k}>
                <label htmlFor={`type_${k}`}>{pt(label)}</label>
                <input
                  id={`type_${k}`}
                  name={`type_${k}`}
                  type="number"
                  inputMode="decimal"
                  step="0.01"
                  min="0"
                  placeholder={pt("{price} (normal price)", { price: f.money(s.default_lesson_price_cents, d.school.currency) })}
                  defaultValue={s.lesson_type_prices?.[k] !== undefined ? cents(s.lesson_type_prices[k]!) : ""}
                />
              </div>
            ))}
          </div>
          <label className="check" style={{ marginBottom: 14 }}>
            <input type="checkbox" name="applyToUpcoming" /> {pt("Also use the new prices for {count} upcoming lessons that aren't billed yet (lessons with a price set by hand keep it)", { count: d.upcoming })}
          </label>
          <button className="primary">{pt("Save prices")}</button>
        </form>
      )}

      <section className="card" id="levels">
        <h2>{pt("Levels and skills")}</h2>
        <p className="small muted">{pt("The steps a student goes through. Instructors tick off skills after each lesson; students see their progress in the app.")}</p>
        {d.levels.map((l) => (
          <form key={l.id} action={saveLevel} className="level-row">
            <input type="hidden" name="levelId" value={l.id} />
            <div className="fields">
              <div className="field"><label htmlFor={`lvl-${l.id}`}>{pt("Level {position}", { position: l.position })}</label><input id={`lvl-${l.id}`} name="name" defaultValue={l.name} /></div>
              <div className="field"><label htmlFor={`lvld-${l.id}`}>{pt("Description")}</label><input id={`lvld-${l.id}`} name="description" defaultValue={l.description ?? ""} /></div>
            </div>
            <div className="chips" style={{ marginBottom: 8 }}>
              {(l.skills ?? []).length ? (l.skills ?? []).map((sk) => <span key={sk} className="chip" style={{ cursor: "default" }}>{sk}</span>) : <span className="small muted">{pt("No skills yet")}</span>}
            </div>
            <div className="row"><input name="newSkill" placeholder={pt("Add a skill")} style={{ maxWidth: 260 }} aria-label={pt("Add a skill")} /><button className="sm">{pt("Save level")}</button></div>
          </form>
        ))}
        <form action={saveLevel} className="row" style={{ marginTop: 14 }}>
          <input name="name" placeholder={pt("New level name")} required style={{ maxWidth: 260 }} aria-label={pt("New level name")} />
          <input name="description" placeholder={pt("Description")} style={{ maxWidth: 260 }} aria-label={pt("Description")} />
          <button className="sm">{pt("Add level")}</button>
        </form>
      </section>

      {owner && (
        <form action={saveIntegrations} className="card" id="integrations">
          <h2>{pt("Connections")}</h2>
          <h3>{pt("WhatsApp Business (Meta Cloud API)")}</h3>
          <p className="small muted">{pt("Point the Meta app webhook to /api/webhooks/whatsapp. The access token is stored encrypted.")}</p>
          <div className="fields">
            <div className="field"><label htmlFor="phone_number_id">{pt("Phone number ID")}</label><input id="phone_number_id" name="phone_number_id" dir="ltr" defaultValue={d.wa?.phone_number_id ?? ""} /></div>
            <div className="field"><label htmlFor="waba_id">{pt("WhatsApp Business account ID")}</label><input id="waba_id" name="waba_id" dir="ltr" defaultValue={d.wa?.waba_id ?? ""} /></div>
            <div className="field"><label htmlFor="display_phone_number">{pt("Number shown to students")}</label><input id="display_phone_number" name="display_phone_number" dir="ltr" defaultValue={d.wa?.display_phone_number ?? ""} /></div>
            <div className="field"><label htmlFor="access_token">{pt("Access token")} {d.wa && <span className="muted">({pt("leave empty to keep")})</span>}</label><input id="access_token" name="access_token" type="password" autoComplete="off" /></div>
          </div>
          <h3>Stripe</h3>
          <p className="small muted">{pt("Online payments and payment methods are set up under")} <a href="/admin/billing#stripe">{pt("Payment settings")}</a>.</p>
          <button className="primary">{pt("Save connections")}</button>
        </form>
      )}
    </>
  );
}
