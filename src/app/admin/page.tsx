import Link from "next/link";
import { DateTime } from "luxon";
import { many, one, withTenant } from "@/lib/db";
import { formatDateTime, formatMoney, formatTimeRange } from "@/lib/time";
import { Badge, Flash, sp, type SearchParams } from "@/components/ui";
import { requireSchoolActor, requireSchoolPage } from "@/server/auth/session";
import { userPrincipal } from "@/server/principal";
import { decideRescheduleRequest } from "@/server/services/lessons";
import { schoolHeader } from "@/server/school";
import { runAction, str } from "@/server/web";

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
    stats: (await one<{ today: number; week: number; active_students: number; leads: number; completed_30d: number; revenue_30d: number; outstanding: number; overdue: number; no_show_30d: number; cancelled_30d: number }>(
      tx,
      `SELECT
         (SELECT count(*)::int FROM lessons WHERE status NOT IN ('cancelled','rescheduled') AND start_time >= $1 AND start_time < $1::timestamptz + interval '1 day') AS today,
         (SELECT count(*)::int FROM lessons WHERE status NOT IN ('cancelled','rescheduled') AND start_time >= $1 AND start_time < $1::timestamptz + interval '7 days') AS week,
         (SELECT count(*)::int FROM students WHERE status = 'active') AS active_students,
         (SELECT count(*)::int FROM students WHERE status = 'lead') AS leads,
         (SELECT count(*)::int FROM lessons WHERE status = 'completed' AND start_time > now() - interval '30 days') AS completed_30d,
         (SELECT COALESCE(sum(amount_cents),0)::int FROM payments WHERE status = 'paid' AND paid_at > now() - interval '30 days') AS revenue_30d,
         (SELECT COALESCE(sum(amount_cents),0)::int FROM payments WHERE status IN ('pending','overdue','failed')) AS outstanding,
         (SELECT count(*)::int FROM payments WHERE status = 'overdue') AS overdue,
         (SELECT count(*)::int FROM lessons WHERE status = 'no_show' AND start_time > now() - interval '30 days') AS no_show_30d,
         (SELECT count(*)::int FROM lessons WHERE status = 'cancelled' AND start_time > now() - interval '30 days') AS cancelled_30d`,
      [today.toJSDate()],
    ))!,
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
  const s = d.stats;
  const money = (c: number) => formatMoney(c, school.currency, school.locale);

  return (
    <>
      <h1>Dashboard</h1>
      <Flash searchParams={q} />
      <div className="grid three">
        <div className="card stat"><div className="value">{s.today}</div><div className="label">Lessons today · {s.week} this week</div></div>
        <div className="card stat"><div className="value">{s.active_students}</div><div className="label">Active students · {s.leads} new leads</div></div>
        <div className="card stat"><div className="value">{money(s.revenue_30d)}</div><div className="label">Received, last 30 days</div></div>
        <div className="card stat"><div className="value">{money(s.outstanding)}</div><div className="label">Outstanding · {s.overdue} overdue</div></div>
        <div className="card stat"><div className="value">{s.completed_30d}</div><div className="label">Lessons completed, 30 days</div></div>
        <div className="card stat"><div className="value">{s.cancelled_30d} / {s.no_show_30d}</div><div className="label">Cancelled / no-show, 30 days</div></div>
      </div>

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
