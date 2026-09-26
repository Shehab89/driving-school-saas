import Link from "next/link";
import { DateTime } from "luxon";
import { many, withTenant } from "@/lib/db";
import { formatDateTime, formatMoney, formatTimeRange } from "@/lib/time";
import { Badge, Flash, sp, type SearchParams } from "@/components/ui";
import { requireSchoolActor, requireSchoolPage } from "@/server/auth/session";
import { userPrincipal } from "@/server/principal";
import { decideRescheduleRequest } from "@/server/services/lessons";
import { schoolHeader } from "@/server/school";
import { runAction, str } from "@/server/web";
import { schoolInsights } from "@/server/services/insights";
import { BarList, ChartTable, ColumnChart, Heatmap, SplitBar, Sparkline, StatTile } from "@/components/charts";

async function decide(fd: FormData) {
  "use server";
  await runAction(async () => {
    const actor = await requireSchoolActor("lessons:write_all");
    await withTenant(actor.schoolId, (tx) => decideRescheduleRequest(tx, userPrincipal(actor), str(fd, "requestId"), str(fd, "decision") === "approve"));
  }, { back: "/admin", okMessage: "Request handled" });
}

export default async function AdminDashboard({ searchParams }: { searchParams: SearchParams }) {
  const q = await sp(searchParams);
  const actor = await requireSchoolPage("school:view_reports");
  const school = await schoolHeader(actor.schoolId);
  const today = DateTime.now().setZone(school.timezone).startOf("day");

  const d = await withTenant(actor.schoolId, async (tx) => ({
    insights: await schoolInsights(tx, school.timezone),
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
  }));
  const money = (c: number) => formatMoney(c, school.currency, school.locale);

  return (
    <>
      <h1>Dashboard</h1>
      <Flash searchParams={q} />
      <Insights ins={d.insights} money={money} zone={school.timezone} />

      <div className="grid two">
        <section className="card">
          <div className="spread"><h2>Today</h2><Link href="/admin/calendar">Calendar →</Link></div>
          {d.todayLessons.length === 0 ? <p className="muted">No lessons today.</p> : (
            <ul>
              {d.todayLessons.map((l) => (
                <li key={l.id}><Link href={`/lessons/${l.id}`}>{formatTimeRange(l.start_time, l.end_time, school.timezone)} {l.student}</Link> · {l.instructor} <Badge value={l.status} /></li>
              ))}
            </ul>
          )}
        </section>
        <section className="card">
          <h2>Needs attention</h2>
          {d.requests.length + d.assessments.length + d.handoffs.length === 0 && <p className="muted">All clear.</p>}
          {d.requests.map((r) => (
            <form key={r.id} action={decide} className="spread" style={{ marginBottom: 8 }}>
              <input type="hidden" name="requestId" value={r.id} />
              <span className="small">Reschedule: <strong>{r.student}</strong> {formatDateTime(r.original_start, school.timezone)} → {formatDateTime(r.requested_start, school.timezone)}</span>
              <span className="row">
                <button name="decision" value="approve" className="primary">Approve</button>
                <button name="decision" value="reject">Reject</button>
              </span>
            </form>
          ))}
          {d.assessments.map((a) => (
            <p key={a.student_id + a.created_at.toISOString()} className="small">AI level suggestion to review: <Link href={`/students/${a.student_id}`}>{a.student}</Link> ({a.suggested_band})</p>
          ))}
          {d.handoffs.map((h) => (
            <p key={h.id} className="small">WhatsApp needs a human: <Link href={`/admin/whatsapp/${h.id}`}>{h.wa_profile_name ?? h.wa_phone_e164}</Link> – {h.handoff_reason}</p>
          ))}
        </section>
      </div>
    </>
  );
}

type Ins = Awaited<ReturnType<typeof schoolInsights>>;

function Insights({ ins, money, zone }: { ins: Ins; money: (c: number) => string; zone: string }) {
  const t = ins.totals;
  const wk = (iso: string) => DateTime.fromISO(iso, { zone }).toFormat("d LLL");
  const compact = (c: number) => (c >= 100000 ? `€${Math.round(c / 100000)}k` : money(c).replace(/[.,]00$/, ""));
  const weeks = ins.revenue.map((r, i) => ({
    key: r.week,
    label: wk(r.week),
    value: r.value,
    highlight: i === ins.revenue.length - 1,
    tip: `Week of ${wk(r.week)}: ${money(r.value)}${i === ins.revenue.length - 1 ? " (so far)" : ""}`,
  }));
  const hours = Array.from({ length: 14 }, (_, i) => i + 7);
  const heatValue = (dow: number, hour: number) => ins.heat.find((h) => h.dow === dow && h.hour === hour)?.n ?? 0;
  const days = [1, 2, 3, 4, 5, 6, 7].map((d) => ({ key: d, label: DateTime.fromObject({ weekday: d as 1 }).toFormat("ccc") }));
  const mix = (state: "paid" | "pending" | "overdue") => ins.payMix.find((m) => m.state === state) ?? { cents: 0, n: 0 };
  const maxLevel = Math.max(1, ...ins.levels.map((l) => l.n));
  const loadMax = Math.max(1, ...ins.load.map((l) => Math.max(l.available_min, l.booked_min)));
  const h = (min: number) => `${Math.round((min / 60) * 10) / 10}h`;

  return (
    <>
      <div className="ch-tiles">
        <StatTile label="Received, last 30 days" value={money(t.revenue_30d)} delta={{ now: t.revenue_30d, prev: t.revenue_prev, label: "vs previous 30 days" }}>
          <Sparkline values={ins.revenue.map((r) => r.value)} tips={ins.revenue.map((r) => `Week of ${wk(r.week)}: ${money(r.value)}`)} ariaLabel="Revenue per week, last 12 weeks" />
        </StatTile>
        <StatTile label="Lessons completed, 30 days" value={t.lessons_30d} delta={{ now: t.lessons_30d, prev: t.lessons_prev, label: "vs previous 30 days" }}>
          <Sparkline values={ins.lessons.map((r) => r.value)} tips={ins.lessons.map((r) => `Week of ${wk(r.week)}: ${r.value} lessons`)} ariaLabel="Completed lessons per week" />
        </StatTile>
        <StatTile label="Active students" value={t.active}>
          <span className="ch-delta">{t.leads} new leads waiting</span>
          <Sparkline values={ins.newStudents.map((r) => r.value)} tips={ins.newStudents.map((r) => `Week of ${wk(r.week)}: ${r.value} new students`)} ariaLabel="New students per week" />
        </StatTile>
        <StatTile label="Outstanding" value={money(t.outstanding)}>
          <span className="ch-delta">{t.overdue > 0 ? <><span aria-hidden style={{ color: "var(--danger)" }}>●</span> {t.overdue} overdue</> : "Nothing overdue"}</span>
          <Link href="/admin/payments" className="small">Open payments →</Link>
        </StatTile>
      </div>

      <div className="grid two">
        <section className="card">
          <div className="ch-card-head"><h2>Revenue per week</h2><span className="sub">Paid, last 12 weeks · this week in amber</span></div>
          <ColumnChart data={weeks} format={compact} labelEvery={2} height={230} ariaLabel="Revenue per week for the last 12 weeks" />
          <ChartTable summary="Show as table" head={["Week of", "Received"]} rows={ins.revenue.map((r) => [wk(r.week), money(r.value)])} />
        </section>
        <section className="card">
          <div className="ch-card-head"><h2>Busiest times</h2><span className="sub">Lessons by start time, 8 weeks back + 2 ahead</span></div>
          <Heatmap
            rows={days}
            cols={hours.map((x) => ({ key: x, label: String(x) }))}
            value={heatValue}
            tip={(d, hr, v) => `${days[d - 1]!.label} ${hr}:00 – ${v} lesson${v === 1 ? "" : "s"}`}
            ariaLabel="Lessons per weekday and start hour"
            legend={["Quiet", "Busy"]}
          />
          <ChartTable
            summary="Show as table"
            head={["Day", ...hours.map((x) => `${x}h`)]}
            rows={days.map((d) => [d.label, ...hours.map((x) => heatValue(d.key, x))])}
          />
        </section>
      </div>

      <div className="grid three">
        <section className="card">
          <div className="ch-card-head"><h2>Payments</h2><span className="sub">Last 90 days</span></div>
          <SplitBar
            ariaLabel="Payment amounts by state"
            parts={[
              { key: "paid", label: "Paid", value: mix("paid").cents, display: money(mix("paid").cents), tone: "good" },
              { key: "pending", label: "Waiting", value: mix("pending").cents, display: money(mix("pending").cents), tone: "warn" },
              { key: "overdue", label: "Overdue / failed", value: mix("overdue").cents, display: money(mix("overdue").cents), tone: "bad" },
            ]}
          />
        </section>
        <section className="card">
          <div className="ch-card-head"><h2>Instructor load</h2><span className="sub">Next 7 days</span></div>
          <BarList
            ariaLabel="Booked hours per instructor, next 7 days"
            items={ins.load.map((l) => ({
              key: l.id,
              label: l.name.split(" ")[0],
              value: l.booked_min,
              max: l.available_min || loadMax,
              display: l.available_min ? `${h(l.booked_min)} / ${h(l.available_min)}` : h(l.booked_min),
              tip: l.available_min
                ? `${l.name}: ${h(l.booked_min)} booked of ${h(l.available_min)} available (${Math.round((l.booked_min / l.available_min) * 100)}%)`
                : `${l.name}: ${h(l.booked_min)} booked, no availability set`,
            }))}
          />
        </section>
        <section className="card">
          <div className="ch-card-head"><h2>Students per level</h2><span className="sub">Active students</span></div>
          <BarList
            ariaLabel="Active students per level"
            items={ins.levels.map((l) => ({
              key: String(l.position ?? "none"),
              label: l.name,
              value: l.n,
              max: maxLevel,
              display: String(l.n),
              muted: l.position === null,
              tip: `${l.name}: ${l.n} student${l.n === 1 ? "" : "s"}`,
            }))}
          />
        </section>
      </div>
    </>
  );
}
