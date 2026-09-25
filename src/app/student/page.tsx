import Link from "next/link";
import { withTenant } from "@/lib/db";
import { formatDate, formatDateTime, formatMoney, formatShortDate, formatTimeRange, durationMinutes } from "@/lib/time";
import { Badge, Flash, ProgressBar, sp, type SearchParams } from "@/components/ui";
import { requireSchoolPage } from "@/server/auth/session";
import { getStudentDashboard } from "@/server/services/students";

export default async function StudentDashboard({ searchParams }: { searchParams: SearchParams }) {
  const q = await sp(searchParams);
  const actor = await requireSchoolPage("lessons:request_reschedule");
  if (!actor.studentId) return <p>No student profile is linked to this account.</p>;
  const d = await withTenant(actor.schoolId, (tx) => getStudentDashboard(tx, actor.schoolId, actor.studentId!));
  const tz = d.timezone;
  const next = d.upcoming[0];
  const level = d.progress.currentLevel;
  const unpaid = d.payments.filter((p) => ["pending", "overdue", "failed"].includes(p.status));

  return (
    <>
      <h1>Hi {d.student.first_name}</h1>
      <Flash searchParams={q} />

      <div className="grid two">
        <section className="card" aria-labelledby="level-h">
          <h2 id="level-h">Driving level</h2>
          {level ? (
            <>
              <div className="spread">
                <strong style={{ fontSize: "1.3rem" }}>
                  Level {level.position} / {d.progress.totalLevels}
                </strong>
                {!d.progress.levelConfirmed && <Badge value="suggested" label="to be confirmed" />}
              </div>
              <p className="muted">{level.name}</p>
            </>
          ) : (
            <p className="muted">Your instructor will set your level after your first lesson.</p>
          )}
          <ProgressBar value={d.progress.percent} label="Overall progress" />
          <div className="grid two" style={{ marginTop: 12 }}>
            <div>
              <h3>Skills completed</h3>
              {d.progress.completed.length ? <ul>{d.progress.completed.map((s) => <li key={s}>{s}</li>)}</ul> : <p className="muted small">None yet</p>}
            </div>
            <div>
              <h3>Needs improvement</h3>
              {d.progress.needsImprovement.length ? <ul>{d.progress.needsImprovement.map((s) => <li key={s}>{s}</li>)}</ul> : <p className="muted small">Nothing flagged</p>}
            </div>
          </div>
        </section>

        <section className="card" aria-labelledby="next-h">
          <h2 id="next-h">Upcoming lesson</h2>
          {next ? (
            <>
              <dl className="kv">
                <dt>Instructor</dt><dd>{next.instructor_name}</dd>
                <dt>Date</dt><dd>{formatDate(next.start_time, tz)}</dd>
                <dt>Time</dt><dd>{formatTimeRange(next.start_time, next.end_time, tz)}</dd>
                <dt>Vehicle</dt><dd>{next.vehicle ?? "—"}</dd>
                <dt>Lesson</dt><dd>Lesson #{next.lesson_number}</dd>
              </dl>
              <div style={{ marginTop: 12 }}>
                {next.pendingRequest ? (
                  <p className="muted">Reschedule request sent for {formatDateTime(next.pendingRequest.requested_start, tz)} — waiting for the school.</p>
                ) : next.canReschedule ? (
                  <>
                    <Link className="btn primary" href={`/student/lessons/${next.id}/reschedule`}>Reschedule lesson</Link>
                    <p className="muted small" style={{ marginTop: 6 }}>Possible until {formatDateTime(next.rescheduleDeadline!, tz)}</p>
                  </>
                ) : (
                  <p className="muted small">{next.rescheduleBlockedReason}</p>
                )}
              </div>
              {d.upcoming.length > 1 && (
                <details style={{ marginTop: 12 }}>
                  <summary>{d.upcoming.length - 1} more upcoming</summary>
                  <ul>
                    {d.upcoming.slice(1).map((l) => (
                      <li key={l.id}>
                        #{l.lesson_number} · {formatDateTime(l.start_time, tz)} with {l.instructor_name}{" "}
                        {l.canReschedule && <Link href={`/student/lessons/${l.id}/reschedule`}>reschedule</Link>}
                      </li>
                    ))}
                  </ul>
                </details>
              )}
            </>
          ) : (
            <p className="muted">No lesson planned. Contact your school to book one.</p>
          )}
        </section>
      </div>

      <section className="card" aria-labelledby="fb-h">
        <h2 id="fb-h">Instructor feedback</h2>
        {d.latestFeedback ? (
          <>
            <p className="muted small">
              Lesson #{d.latestFeedback.lesson_number} · {formatDate(d.latestFeedback.start_time, tz)} · {d.latestFeedback.instructor_name}
            </p>
            <div className="grid two">
              <div><h3>What went well</h3><p>{d.latestFeedback.strengths || "—"}</p></div>
              <div><h3>What needs improvement</h3><p>{d.latestFeedback.weaknesses || "—"}</p></div>
              <div><h3>What to practice</h3><p>{d.latestFeedback.practice_items || "—"}</p></div>
              <div><h3>Next lesson focus</h3><p>{d.latestFeedback.next_focus || "—"}</p></div>
            </div>
          </>
        ) : (
          <p className="muted">Feedback appears here after your lessons.</p>
        )}
      </section>

      <section className="card" aria-labelledby="pay-h">
        <div className="spread">
          <h2 id="pay-h">Payments</h2>
          <span className="muted small">
            {unpaid.length ? `${unpaid.length} open · ${formatMoney(unpaid.reduce((a, p) => a + p.amount_cents, 0), d.currency)}` : "All paid"}
          </span>
        </div>
        {d.payments.length === 0 ? (
          <p className="muted">No payments yet.</p>
        ) : (
          <div className="table-wrap">
            <table className="stack-table">
              <thead><tr><th>For</th><th>Amount</th><th>Due</th><th>Status</th><th /></tr></thead>
              <tbody>
                {d.payments.map((p) => (
                  <tr key={p.id}>
                    <td data-label="For">{p.lesson_number ? `Lesson #${p.lesson_number}` : p.reference}</td>
                    <td data-label="Amount">{formatMoney(p.amount_cents, p.currency)}</td>
                    <td data-label="Due">{formatShortDate(`${p.due_date}T12:00:00Z`, tz)}</td>
                    <td data-label="Status"><Badge value={p.status} /></td>
                    <td data-label="">{["pending", "overdue", "failed"].includes(p.status) && <a className="btn primary" href={`/pay/${p.pay_token}`}>Pay now</a>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="card" aria-labelledby="hist-h">
        <h2 id="hist-h">Lesson history</h2>
        {d.history.length === 0 ? (
          <p className="muted">No lessons yet.</p>
        ) : (
          <div className="table-wrap">
            <table className="stack-table">
              <thead><tr><th>#</th><th>Date</th><th>Instructor</th><th>Duration</th><th>Feedback</th><th>Payment</th></tr></thead>
              <tbody>
                {d.history.map((l) => (
                  <tr key={l.id}>
                    <td data-label="Lesson">#{l.lesson_number} <Badge value={l.status} /></td>
                    <td data-label="Date">{formatShortDate(l.start_time, tz)}</td>
                    <td data-label="Instructor">{l.instructor_name}</td>
                    <td data-label="Duration">{durationMinutes(l.start_time, l.end_time)} min</td>
                    <td data-label="Feedback" className="small">{l.has_feedback ? (l.next_focus ? `Next: ${l.next_focus}` : l.strengths ?? "✓") : "—"}</td>
                    <td data-label="Payment"><Badge value={l.payment_status} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}
