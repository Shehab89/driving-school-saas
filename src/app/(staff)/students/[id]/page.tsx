import Link from "next/link";
import { many, one, withTenant } from "@/lib/db";
import { can } from "@/lib/rbac";
import { formatDate, formatDateTime } from "@/lib/time";
import { Badge, Flash, ProgressBar, sp, type SearchParams } from "@/components/ui";
import { requireSchoolActor, requireSchoolPage } from "@/server/auth/session";
import { userPrincipal } from "@/server/principal";
import { assertCanViewStudent } from "@/server/services/students";
import { getProgressSummary } from "@/server/services/progress";
import { reviewAssessment } from "@/server/services/assessments";
import { runAction, str } from "@/server/web";
import { ForbiddenError } from "@/lib/errors";

async function reviewAction(fd: FormData) {
  "use server";
  await runAction(async () => {
    const actor = await requireSchoolActor("assessments:review");
    await withTenant(actor.schoolId, (tx) => reviewAssessment(tx, userPrincipal(actor), str(fd, "assessmentId"), str(fd, "levelId"), str(fd, "reason") || undefined));
  }, { back: `/students/${str(fd, "studentId")}`, okMessage: "Level confirmed" });
}

export default async function StudentProfile({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: SearchParams }) {
  const { id } = await params;
  const q = await sp(searchParams);
  const actor = await requireSchoolPage("lessons:operate_own");
  const d = await withTenant(actor.schoolId, async (tx) => {
    try {
      await assertCanViewStudent(tx, userPrincipal(actor), id);
    } catch (e) {
      if (e instanceof ForbiddenError) return null;
      throw e;
    }
    const s = await one<{ id: string; first_name: string; last_name: string; student_number: string; email: string | null; phone: string | null; license_category: string; preferred_transmission: string; status: string; notes: string | null; tz: string; date_of_birth: string | null }>(
      tx,
      `SELECT st.*, sc.timezone AS tz FROM students st JOIN schools sc ON sc.id = st.school_id WHERE st.id = $1`,
      [id],
    );
    if (!s) return null;
    return {
      s,
      progress: await getProgressSummary(tx, id),
      levels: await many<{ id: string; name: string }>(tx, `SELECT id, name FROM level_definitions ORDER BY position`),
      lessons: await many<{ id: string; lesson_number: number; start_time: Date; status: string; payment_status: string; instructor: string; strengths: string | null; weaknesses: string | null; next_focus: string | null }>(
        tx,
        `SELECT l.id, l.lesson_number, l.start_time, l.status, l.payment_status, i.first_name AS instructor, f.strengths, f.weaknesses, f.next_focus
           FROM lessons l JOIN instructors i ON i.id = l.instructor_id LEFT JOIN lesson_feedback f ON f.lesson_id = l.id
          WHERE l.student_id = $1 AND l.status <> 'rescheduled' ORDER BY l.start_time DESC LIMIT 100`,
        [id],
      ),
      assessments: await many<{ id: string; created_at: Date; suggested_band: string; confidence: string; status: string; rationale: string | null; answers: Record<string, unknown>; suggested_level_id: string | null; suggested_level: string | null; final_level: string | null }>(
        tx,
        `SELECT a.*, sl.name AS suggested_level, fl.name AS final_level FROM assessments a
           LEFT JOIN level_definitions sl ON sl.id = a.suggested_level_id LEFT JOIN level_definitions fl ON fl.id = a.final_level_id
          WHERE a.student_id = $1 ORDER BY a.created_at DESC`,
        [id],
      ),
    };
  });
  if (!d) return <p>Student not found.</p>;
  const { s, progress: p } = d;
  const staff = can(actor.role, "students:read_all");

  return (
    <>
      <div className="spread">
        <h1>{s.first_name} {s.last_name}</h1>
        <div className="row">
          <Badge value={s.status} />
          {staff && <Link className="btn primary" href={`/admin/lessons/new?student=${s.id}`}>Book lesson</Link>}
        </div>
      </div>
      <Flash searchParams={q} />
      <div className="grid two">
        <section className="card">
          <dl className="kv">
            <dt>Student no.</dt><dd>{s.student_number}</dd>
            <dt>Phone</dt><dd>{s.phone ? <a href={`tel:${s.phone}`}>{s.phone}</a> : "—"}</dd>
            <dt>E-mail</dt><dd>{s.email ?? "—"}</dd>
            <dt>Licence</dt><dd>{s.license_category} · {s.preferred_transmission}</dd>
            {s.date_of_birth && (<><dt>Born</dt><dd>{s.date_of_birth}</dd></>)}
          </dl>
          {s.notes && <p className="small muted" style={{ marginTop: 8, whiteSpace: "pre-wrap" }}>{s.notes}</p>}
        </section>
        <section className="card">
          <div className="spread">
            <h2>Progress</h2>
            {p.currentLevel && <span>Level {p.currentLevel.position} / {p.totalLevels} {!p.levelConfirmed && <Badge value="suggested" label="unconfirmed" />}</span>}
          </div>
          <ProgressBar value={p.percent} label="Progress" />
          <ul className="small" style={{ columns: 2 }}>
            {p.skills.map((sk) => (
              <li key={sk.id}>{sk.name} {sk.status !== "not_started" && <Badge value={sk.status === "completed" ? "completed" : sk.status === "needs_improvement" ? "overdue" : "pending"} label={sk.status.replace("_", " ")} />}</li>
            ))}
          </ul>
        </section>
      </div>

      {d.assessments.length > 0 && (
        <section className="card">
          <h2>Assessments</h2>
          {d.assessments.map((a) => (
            <div key={a.id} style={{ borderTop: "1px solid var(--border)", paddingTop: 8, marginTop: 8 }}>
              <div className="spread">
                <span>{formatDateTime(a.created_at, s.tz)} · suggested <strong>{a.suggested_level ?? a.suggested_band}</strong> (confidence {Math.round(Number(a.confidence) * 100)}%)</span>
                <Badge value={a.status === "suggested" ? "suggested" : "completed"} label={a.status} />
              </div>
              <p className="small muted">{a.rationale}</p>
              <details className="small"><summary>Answers</summary><pre style={{ whiteSpace: "pre-wrap" }}>{JSON.stringify(a.answers, null, 2)}</pre></details>
              {a.final_level && <p className="small">Final level: {a.final_level}</p>}
              {a.status === "suggested" && can(actor.role, "assessments:review") && (
                <form action={reviewAction} className="row" style={{ marginTop: 8 }}>
                  <input type="hidden" name="assessmentId" value={a.id} />
                  <input type="hidden" name="studentId" value={s.id} />
                  <select name="levelId" defaultValue={a.suggested_level_id ?? ""} aria-label="Final level" style={{ width: "auto" }}>
                    {d.levels.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
                  </select>
                  <input name="reason" placeholder="Reason if overriding" style={{ width: 220 }} />
                  <button className="primary">Confirm / override</button>
                </form>
              )}
            </div>
          ))}
        </section>
      )}

      <section className="card">
        <h2>Lessons</h2>
        <div className="table-wrap">
          <table>
            <thead><tr><th>#</th><th>Date</th><th>Instructor</th><th>Status</th><th>Feedback</th><th>Payment</th></tr></thead>
            <tbody>
              {d.lessons.map((l) => (
                <tr key={l.id}>
                  <td><Link href={`/lessons/${l.id}`}>{l.lesson_number}</Link></td>
                  <td>{formatDate(l.start_time, s.tz)}</td>
                  <td>{l.instructor}</td>
                  <td><Badge value={l.status} /></td>
                  <td className="small">{[l.strengths && `+ ${l.strengths}`, l.weaknesses && `− ${l.weaknesses}`, l.next_focus && `→ ${l.next_focus}`].filter(Boolean).join(" ") || "—"}</td>
                  <td><Badge value={l.payment_status} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
      {!staff && <p className="small muted">You see this student because you teach them.</p>}
    </>
  );
}
