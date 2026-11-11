import Link from "next/link";
import { bandLabel } from "@/i18n/assessment-text";
import { DateTime } from "luxon";
import { many, withTenant } from "@/lib/db";
import { unplannedStudents } from "@/server/services/attention";
import { Flash, StatusBadge, sp, type SearchParams } from "@/components/ui";
import { requireSchoolActor, requireSchoolPage } from "@/server/auth/session";
import { userPrincipal } from "@/server/principal";
import { decideRescheduleRequest } from "@/server/services/lessons";
import { schoolI18n } from "@/server/school";
import { runAction, str } from "@/server/web";
import { getPt } from "@/i18n/server";
import type { PortalTranslate } from "@/i18n/portal";
import type { Formatter } from "@/i18n";
import { schoolInsights } from "@/server/services/insights";
import { setupChecklist } from "@/server/services/onboarding";
import { partOfDay } from "@/lib/relative-time";
import { PortalIcon } from "@/components/portal-nav";
import { BarList, ChartTable, ColumnChart, Heatmap, SplitBar, Sparkline, StatTile } from "@/components/charts";

async function decide(fd: FormData) {
  "use server";
  const pt = await getPt();
  const approve = str(fd, "decision") === "approve";
  await runAction(async () => {
    const actor = await requireSchoolActor("lessons:write_all");
    await withTenant(actor.schoolId, (tx) => decideRescheduleRequest(tx, userPrincipal(actor), str(fd, "requestId"), approve));
  }, { back: "/admin", okMessage: approve ? pt("Change approved, the student has been told") : pt("Change declined, the student has been told") });
}

export default async function AdminDashboard({ searchParams }: { searchParams: SearchParams }) {
  const q = await sp(searchParams);
  const actor = await requireSchoolPage("school:view_reports");
  const { school, t, f, pt } = await schoolI18n(actor.schoolId);
  const today = DateTime.now().setZone(school.timezone).startOf("day");

  const d = await withTenant(actor.schoolId, async (tx) => ({
    insights: await schoolInsights(tx, school.timezone),
    setup: await setupChecklist(tx),
    todayLessons: await many<{ id: string; start_time: Date; end_time: Date; student: string; instructor: string; status: string }>(
      tx,
      `SELECT l.id, l.start_time, l.end_time, s.first_name || ' ' || s.last_name AS student, i.first_name AS instructor, l.status
         FROM lessons l JOIN students s ON s.id = l.student_id JOIN instructors i ON i.id = l.instructor_id
        WHERE l.status NOT IN ('rescheduled') AND l.start_time >= $1 AND l.start_time < $1::timestamptz + interval '1 day' ORDER BY l.start_time`,
      [today.toJSDate()],
    ),
    requests: await many<{ id: string; student: string; original_start: Date; requested_start: Date; reason: string | null }>(
      tx,
      `SELECT r.id, s.first_name || ' ' || s.last_name AS student, r.original_start, r.requested_start, r.reason
         FROM reschedule_requests r JOIN students s ON s.id = r.student_id WHERE r.status = 'pending' ORDER BY r.created_at`,
    ),
    assessments: await many<{ student_id: string; student: string; suggested_band: string; created_at: Date }>(
      tx,
      `SELECT a.student_id, s.first_name || ' ' || s.last_name AS student, a.suggested_band, a.created_at
         FROM assessments a JOIN students s ON s.id = a.student_id WHERE a.status = 'suggested' ORDER BY a.created_at LIMIT 10`,
    ),
    handoffs: await many<{ id: string; wa_phone_e164: string; wa_profile_name: string | null; handoff_reason: string | null }>(
      tx,
      `SELECT id, wa_phone_e164, wa_profile_name, handoff_reason FROM whatsapp_conversations WHERE status = 'handoff' ORDER BY last_message_at DESC LIMIT 10`,
    ),
    unplanned: await unplannedStudents(tx, null, 200),
  }));
  const money = (c: number) => f.money(c, school.currency);
  const todo = d.requests.length + d.assessments.length + d.handoffs.length;
  const setupOpen = d.setup.filter((s) => !s.done && !s.optional).length;
  const greet = { morning: pt("Good morning"), afternoon: pt("Good afternoon"), evening: pt("Good evening") }[partOfDay(new Date(), school.timezone)];
  const live = d.todayLessons.filter((l) => !["cancelled", "rescheduled"].includes(l.status));
  const doneToday = live.filter((l) => ["completed", "no_show"].includes(l.status)).length;
  const glance: Array<{ icon: string; value: string | number; label: string; href: string; tone?: string }> = [
    { icon: "calendar", value: live.length, label: pt("Lessons today"), href: "/admin/calendar", tone: "accent" },
    { icon: "reports", value: `${doneToday}/${live.length}`, label: pt("Done so far"), href: "/admin/calendar" },
    { icon: "support", value: todo, label: pt("Waiting for you"), href: "#attention", tone: todo ? "warn" : undefined },
    { icon: "payments", value: d.insights.totals.overdue, label: pt("Overdue payments"), href: "/admin/payments", tone: d.insights.totals.overdue ? "bad" : undefined },
  ];

  return (
    <>
      <div className="page-title">
        <div>
          <h1>{greet}</h1>
          <p>{f.date(new Date())}</p>
        </div>
        <div className="actions">
          <Link className="btn" href="/admin/students?new=1">{pt("Add student")}</Link>
          <Link className="btn primary" href="/admin/lessons/new">{pt("Plan a lesson")}</Link>
        </div>
      </div>
      <Flash searchParams={q} />
      <nav className="glance" aria-label={pt("Today at a glance")}>
        {glance.map((g) => (
          <Link key={g.label} href={g.href} className={`glance-tile ${g.tone ?? ""}`}>
            <span className="glance-icon"><PortalIcon name={g.icon} /></span>
            <span><strong className="num">{g.value}</strong><span className="small muted">{g.label}</span></span>
          </Link>
        ))}
      </nav>
      {setupOpen > 0 && (
        <section className="card setup-card" aria-labelledby="setup-title">
          <div className="spread">
            <h2 id="setup-title">{pt("Finish setting up your school")}</h2>
            <span className="badge warning">{pt("{done} of {total} done", { done: d.setup.filter((s) => s.done).length, total: d.setup.length })}</span>
          </div>
          <ol className="checklist">
            {d.setup.map((s) => (
              <li key={s.key} className={s.done ? "done" : ""}>
                <span className="tick" aria-hidden="true">{s.done ? "✓" : ""}</span>
                {s.done ? <span className="muted">{pt(s.label)}</span> : <Link href={s.href}>{pt(s.label)}</Link>}
                {s.optional && !s.done ? <span className="small muted"> · {pt("optional")}</span> : null}
                <span className="sr-only">{s.done ? pt("(done)") : pt("(to do)")}</span>
              </li>
            ))}
          </ol>
        </section>
      )}

      <div className="grid two">
        <section className="card" id="attention">
          <div className="spread">
            <h2>{pt("Needs your attention")}</h2>
            {todo > 0 && <span className="badge warning">{todo}</span>}
          </div>
          {todo === 0 && <p className="muted">{pt("All clear. Nothing is waiting for you.")}</p>}
          {d.requests.map((r) => (
            <form key={r.id} action={decide} className="todo-row">
              <input type="hidden" name="requestId" value={r.id} />
              <div>
                <strong>{r.student}</strong> {pt("wants to move a lesson")}
                <div className="small muted">{f.dateTime(r.original_start)} → <strong>{f.dateTime(r.requested_start)}</strong>{r.reason ? ` · “${r.reason}”` : ""}</div>
              </div>
              <span className="row">
                <button name="decision" value="approve" className="primary sm">{pt("Approve")}</button>
                <button name="decision" value="reject" className="sm">{pt("Decline")}</button>
              </span>
            </form>
          ))}
          {d.assessments.map((a) => (
            <div key={a.student_id + a.created_at.toISOString()} className="todo-row">
              <div>
                <strong>{a.student}</strong> {pt("needs a starting level")}
                <div className="small muted">{pt("The assistant suggests: {level}", { level: bandLabel(a.suggested_band, pt) })}</div>
              </div>
              <Link className="btn sm" href={`/students/${a.student_id}`}>{pt("Review")}</Link>
            </div>
          ))}
          {d.handoffs.map((h) => (
            <div key={h.id} className="todo-row">
              <div>
                <strong>{h.wa_profile_name ?? h.wa_phone_e164}</strong> {pt("asked for a person on WhatsApp")}
                {h.handoff_reason && <div className="small muted">{h.handoff_reason}</div>}
              </div>
              <Link className="btn sm" href={`/admin/whatsapp/${h.id}`}>{pt("Reply")}</Link>
            </div>
          ))}
          {d.unplanned.length > 0 && (
            <div data-testid="unplanned-portal">
              <h3 className="small muted" style={{ margin: "14px 0 6px", textTransform: "uppercase", letterSpacing: ".04em" }}>
                {pt("No next lesson planned ({count})", { count: d.unplanned.length })}
              </h3>
              {d.unplanned.slice(0, 5).map((u) => (
                <div key={u.id} className="todo-row">
                  <div>
                    <strong>{u.name}</strong>
                    <div className="small muted">{u.last_lesson ? pt("Last lesson {date}", { date: f.shortDate(u.last_lesson) }) : pt("No lessons yet")}{u.credit > 0 ? ` · ${pt("{count} lessons paid", { count: u.credit })}` : ""}</div>
                  </div>
                  <Link className="btn sm" href={`/admin/lessons/new?student=${u.id}`}>{pt("Plan")}</Link>
                </div>
              ))}
              {d.unplanned.length > 5 && <p className="small muted" style={{ margin: "8px 0 0" }}>{pt("and {count} more", { count: d.unplanned.length - 5 })}</p>}
            </div>
          )}
        </section>
        <section className="card">
          <div className="spread"><h2>{pt("Today")}</h2><Link href="/admin/calendar">{pt("Open calendar")} <span className="flip">→</span></Link></div>
          {d.todayLessons.length === 0 ? <p className="muted">{pt("No lessons today.")}</p> : (
            <div>
              {d.todayLessons.map((l) => (
                <Link key={l.id} href={`/lessons/${l.id}`} className="list-row">
                  <span>
                    <span className="num" dir="ltr"><strong>{f.range(l.start_time, l.end_time)}</strong></span> {l.student}
                    <span className="sub"> · {l.instructor}</span>
                  </span>
                  <StatusBadge value={l.status} t={t} />
                </Link>
              ))}
            </div>
          )}
        </section>
      </div>

      <h2 className="section-title">{pt("How the school is doing")}</h2>
      <Insights ins={d.insights} money={money} f={f} pt={pt} />
    </>
  );
}

type Ins = Awaited<ReturnType<typeof schoolInsights>>;

function Insights({ ins, money, f, pt }: { ins: Ins; money: (c: number) => string; f: Formatter; pt: PortalTranslate }) {
  const t = ins.totals;
  const wk = (iso: string) => f.luxon(DateTime.fromISO(iso).toJSDate()).toFormat("d LLL");
  const compact = (c: number) => (c >= 100000 ? `€${Math.round(c / 100000)}k` : money(c).replace(/[.,]00(?=\D*$)/, ""));
  const weeks = ins.revenue.map((r, i) => ({
    key: r.week,
    label: wk(r.week),
    value: r.value,
    highlight: i === ins.revenue.length - 1,
    tip: `${pt("Week of {date}", { date: wk(r.week) })}: ${money(r.value)}${i === ins.revenue.length - 1 ? ` (${pt("so far")})` : ""}`,
  }));
  const hours = Array.from({ length: 14 }, (_, i) => i + 7);
  const heatValue = (dow: number, hour: number) => ins.heat.find((h) => h.dow === dow && h.hour === hour)?.n ?? 0;
  const days = [1, 2, 3, 4, 5, 6, 7].map((d) => ({ key: d, label: f.weekdayShort(d) }));
  const mix = (state: "paid" | "pending" | "overdue") => ins.payMix.find((m) => m.state === state) ?? { cents: 0, n: 0 };
  const maxLevel = Math.max(1, ...ins.levels.map((l) => l.n));
  const loadMax = Math.max(1, ...ins.load.map((l) => Math.max(l.available_min, l.booked_min)));
  const h = (min: number) => pt("{hours}h", { hours: f.number(min / 60) });
  const vsPrev = pt("vs previous 30 days");
  const asTable = pt("Show as table");

  return (
    <>
      <div className="ch-tiles">
        <StatTile label={pt("Received, last 30 days")} value={money(t.revenue_30d)} delta={{ now: t.revenue_30d, prev: t.revenue_prev, label: vsPrev }}>
          <Sparkline values={ins.revenue.map((r) => r.value)} tips={ins.revenue.map((r) => `${pt("Week of {date}", { date: wk(r.week) })}: ${money(r.value)}`)} ariaLabel={pt("Revenue per week, last 12 weeks")} />
        </StatTile>
        <StatTile label={pt("Lessons given, last 30 days")} value={t.lessons_30d} delta={{ now: t.lessons_30d, prev: t.lessons_prev, label: vsPrev }}>
          <Sparkline values={ins.lessons.map((r) => r.value)} tips={ins.lessons.map((r) => `${pt("Week of {date}", { date: wk(r.week) })}: ${pt("{count} lessons", { count: r.value })}`)} ariaLabel={pt("Lessons given per week")} />
        </StatTile>
        <StatTile label={pt("Active students")} value={t.active}>
          <span className="ch-delta">{pt("{count} new sign-ups waiting", { count: t.leads })}</span>
          <Sparkline values={ins.newStudents.map((r) => r.value)} tips={ins.newStudents.map((r) => `${pt("Week of {date}", { date: wk(r.week) })}: ${pt("{count} new students", { count: r.value })}`)} ariaLabel={pt("New students per week")} />
        </StatTile>
        <StatTile label={pt("Still to be paid")} value={money(t.outstanding)}>
          <span className="ch-delta">{t.overdue > 0 ? <><span aria-hidden style={{ color: "var(--danger)" }}>●</span> {pt("{count} overdue", { count: t.overdue })}</> : pt("Nothing overdue")}</span>
          <Link href="/admin/payments" className="small">{pt("Open payments")} <span className="flip">→</span></Link>
        </StatTile>
      </div>

      <div className="grid two">
        <section className="card">
          <div className="ch-card-head"><h2>{pt("Money received per week")}</h2><span className="sub">{pt("Last 12 weeks · this week in amber")}</span></div>
          <ColumnChart data={weeks} format={compact} labelEvery={2} height={230} ariaLabel={pt("Revenue per week, last 12 weeks")} />
          <ChartTable summary={asTable} head={[pt("Week of"), pt("Received")]} rows={ins.revenue.map((r) => [wk(r.week), money(r.value)])} />
        </section>
        <section className="card">
          <div className="ch-card-head"><h2>{pt("Busiest times")}</h2><span className="sub">{pt("Lessons by start time, 8 weeks back and 2 ahead")}</span></div>
          <Heatmap
            rows={days}
            cols={hours.map((x) => ({ key: x, label: String(x) }))}
            value={heatValue}
            tip={(d, hr, v) => `${days[d - 1]!.label} ${hr}:00 – ${pt("{count} lessons", { count: v })}`}
            ariaLabel={pt("Lessons per weekday and start hour")}
            legend={[pt("Quiet"), pt("Busy")]}
          />
          <ChartTable summary={asTable} head={[pt("Day"), ...hours.map((x) => `${x}:00`)]} rows={days.map((d) => [d.label, ...hours.map((x) => heatValue(d.key, x))])} />
        </section>
      </div>

      <div className="grid three">
        <section className="card">
          <div className="ch-card-head"><h2>{pt("Payments")}</h2><span className="sub">{pt("Last 90 days")}</span></div>
          <SplitBar
            ariaLabel={pt("Payment amounts by state")}
            parts={[
              { key: "paid", label: pt("Paid"), value: mix("paid").cents, display: money(mix("paid").cents), tone: "good" },
              { key: "pending", label: pt("Waiting"), value: mix("pending").cents, display: money(mix("pending").cents), tone: "warn" },
              { key: "overdue", label: pt("Overdue / failed"), value: mix("overdue").cents, display: money(mix("overdue").cents), tone: "bad" },
            ]}
          />
        </section>
        <section className="card">
          <div className="ch-card-head"><h2>{pt("Instructor workload")}</h2><span className="sub">{pt("Next 7 days")}</span></div>
          <BarList
            ariaLabel={pt("Booked hours per instructor, next 7 days")}
            items={ins.load.map((l) => ({
              key: l.id,
              label: l.name.split(" ")[0],
              value: l.booked_min,
              max: l.available_min || loadMax,
              display: l.available_min ? `${h(l.booked_min)} / ${h(l.available_min)}` : h(l.booked_min),
              tip: l.available_min
                ? pt("{name}: {booked} booked of {available} available ({pct}%)", { name: l.name, booked: h(l.booked_min), available: h(l.available_min), pct: Math.round((l.booked_min / l.available_min) * 100) })
                : pt("{name}: {booked} booked, no working hours set", { name: l.name, booked: h(l.booked_min) }),
            }))}
          />
        </section>
        <section className="card">
          <div className="ch-card-head"><h2>{pt("Students per level")}</h2><span className="sub">{pt("Active students")}</span></div>
          <BarList
            ariaLabel={pt("Active students per level")}
            items={ins.levels.map((l) => ({
              key: String(l.position ?? "none"),
              label: l.name,
              value: l.n,
              max: maxLevel,
              display: String(l.n),
              muted: l.position === null,
              tip: `${l.name}: ${pt("{count} students", { count: l.n })}`,
            }))}
          />
        </section>
      </div>
    </>
  );
}
