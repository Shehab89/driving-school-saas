import Link from "next/link";
import { many, one, withTenant } from "@/lib/db";
import { can } from "@/lib/rbac";
import { Badge, Flash, ProgressBar, StatusBadge, sp, type SearchParams } from "@/components/ui";
import { schoolI18n } from "@/server/school";
import { getI18n } from "@/i18n/server";
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
  }, { back: `/students/${str(fd, "studentId")}`, okMessage: (await getI18n()).t("studentProfile.levelConfirmed") });
}

export default async function StudentProfile({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: SearchParams }) {
  const { id } = await params;
  const q = await sp(searchParams);
  const actor = await requireSchoolPage("lessons:operate_own");
  const { t, f, locale } = await schoolI18n(actor.schoolId);
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
      progress: await getProgressSummary(tx, id, locale),
      levels: await many<{ id: string; name: string }>(tx, `SELECT id, COALESCE(name_translations->>$1, name) AS name FROM level_definitions ORDER BY position`, [locale]),
      lessons: await many<{ id: string; lesson_number: number; start_time: Date; status: string; payment_status: string; instructor: string; strengths: string | null; weaknesses: string | null; next_focus: string | null }>(
        tx,
        `SELECT l.id, l.lesson_number, l.start_time, l.status, l.payment_status, i.first_name AS instructor, f.strengths, f.weaknesses, f.next_focus
           FROM lessons l JOIN instructors i ON i.id = l.instructor_id LEFT JOIN lesson_feedback f ON f.lesson_id = l.id
          WHERE l.student_id = $1 AND l.status <> 'rescheduled' ORDER BY l.start_time DESC LIMIT 100`,
        [id],
      ),
      assessments: await many<{ id: string; created_at: Date; suggested_band: string; confidence: string; status: string; rationale: string | null; answers: Record<string, unknown>; suggested_level_id: string | null; suggested_level: string | null; final_level: string | null }>(
        tx,
        `SELECT a.*, COALESCE(sl.name_translations->>$2, sl.name) AS suggested_level, COALESCE(fl.name_translations->>$2, fl.name) AS final_level FROM assessments a
           LEFT JOIN level_definitions sl ON sl.id = a.suggested_level_id LEFT JOIN level_definitions fl ON fl.id = a.final_level_id
          WHERE a.student_id = $1 ORDER BY a.created_at DESC`,
        [id, locale],
      ),
    };
  });
  if (!d) return <p>{t("common.notFound")}</p>;
  const { s, progress: p } = d;
  const staff = can(actor.role, "students:read_all");
  const skillTone = (st: string) => (st === "completed" ? "completed" : st === "needs_improvement" ? "overdue" : "pending");

  return (
    <>
      <div className="spread">
        <h1>{s.first_name} {s.last_name}</h1>
        <div className="row">
          <StatusBadge value={s.status} t={t} />
          {staff && <Link className="btn primary" href={`/admin/lessons/new?student=${s.id}`}>{t("studentProfile.bookLesson")}</Link>}
        </div>
      </div>
      <Flash searchParams={q} />
      <div className="grid two">
        <section className="card">
          <dl className="kv">
            <dt>{t("studentProfile.number")}</dt><dd>{s.student_number}</dd>
            <dt>{t("common.phone")}</dt><dd>{s.phone ? <a dir="ltr" href={`tel:${s.phone}`}>{s.phone}</a> : t("common.none")}</dd>
            <dt>{t("common.email")}</dt><dd dir="ltr">{s.email ?? t("common.none")}</dd>
            <dt>{t("studentProfile.licence")}</dt><dd>{s.license_category} · {s.preferred_transmission === "automatic" ? t("student.automatic") : t("student.manual")}</dd>
            {s.date_of_birth && (<><dt>{t("studentProfile.born")}</dt><dd>{f.isoDate(s.date_of_birth)}</dd></>)}
          </dl>
          {s.notes && <p className="small muted" style={{ marginTop: 8, whiteSpace: "pre-wrap" }}>{s.notes}</p>}
        </section>
        <section className="card">
          <div className="spread">
            <h2>{t("studentProfile.progress")}</h2>
            {p.currentLevel && (
              <span>
                {t("common.levelOf", { position: p.currentLevel.position, total: p.totalLevels })}{" "}
                {!p.levelConfirmed && <Badge value="suggested" label={t("studentProfile.unconfirmed")} />}
              </span>
            )}
          </div>
          <ProgressBar value={p.percent} label={t("studentProfile.progress")} />
          <ul className="small" style={{ columns: 2 }}>
            {p.skills.map((sk) => (
              <li key={sk.id}>
                {sk.name} {sk.status !== "not_started" && <Badge value={skillTone(sk.status)} label={t(`skillStatus.${sk.status}`)} />}
              </li>
            ))}
          </ul>
        </section>
      </div>

      {d.assessments.length > 0 && (
        <section className="card">
          <h2>{t("studentProfile.assessments")}</h2>
          {d.assessments.map((a) => (
            <div key={a.id} style={{ borderTop: "1px solid var(--border)", paddingTop: 8, marginTop: 8 }}>
              <div className="spread">
                <span>{f.dateTime(a.created_at)} · {t("studentProfile.suggested", { level: a.suggested_level ?? a.suggested_band, pct: Math.round(Number(a.confidence) * 100) })}</span>
                <StatusBadge value={a.status === "suggested" ? "suggested" : "completed"} t={t} />
              </div>
              <p className="small muted">{a.rationale}</p>
              <details className="small"><summary>{t("studentProfile.answers")}</summary><pre dir="ltr" style={{ whiteSpace: "pre-wrap" }}>{JSON.stringify(a.answers, null, 2)}</pre></details>
              {a.final_level && <p className="small">{t("studentProfile.finalLevel", { level: a.final_level })}</p>}
              {a.status === "suggested" && can(actor.role, "assessments:review") && (
                <form action={reviewAction} className="row" style={{ marginTop: 8 }}>
                  <input type="hidden" name="assessmentId" value={a.id} />
                  <input type="hidden" name="studentId" value={s.id} />
                  <select name="levelId" defaultValue={a.suggested_level_id ?? ""} aria-label={t("studentProfile.finalLevel", { level: "" })} style={{ width: "auto" }}>
                    {d.levels.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
                  </select>
                  <input name="reason" placeholder={t("studentProfile.overrideReason")} style={{ width: 220 }} />
                  <button className="primary">{t("studentProfile.confirmOverride")}</button>
                </form>
              )}
            </div>
          ))}
        </section>
      )}

      <section className="card">
        <h2>{t("studentProfile.lessons")}</h2>
        <div className="table-wrap">
          <table className="stack-table">
            <thead><tr><th>#</th><th>{t("common.date")}</th><th>{t("common.instructor")}</th><th>{t("common.status")}</th><th>{t("studentProfile.feedback")}</th><th>{t("studentProfile.payment")}</th></tr></thead>
            <tbody>
              {d.lessons.map((l) => (
                <tr key={l.id}>
                  <td data-label="#"><Link href={`/lessons/${l.id}`}>{l.lesson_number}</Link></td>
                  <td data-label={t("common.date")}>{f.shortDate(l.start_time)}</td>
                  <td data-label={t("common.instructor")}>{l.instructor}</td>
                  <td data-label={t("common.status")}><StatusBadge value={l.status} t={t} /></td>
                  <td data-label={t("studentProfile.feedback")} className="small">{[l.strengths && `+ ${l.strengths}`, l.weaknesses && `− ${l.weaknesses}`, l.next_focus && `→ ${l.next_focus}`].filter(Boolean).join(" ") || t("common.none")}</td>
                  <td data-label={t("studentProfile.payment")}><StatusBadge value={l.payment_status} t={t} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
      {!staff && <p className="small muted">{t("studentProfile.teachesNote")}</p>}
    </>
  );
}
