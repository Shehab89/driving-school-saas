import Link from "next/link";
import { many, one, withTenant } from "@/lib/db";
import { ForbiddenError } from "@/lib/errors";
import { ProgressBar } from "@/components/ui";
import { requireSchoolPage } from "@/server/auth/session";
import { userPrincipal } from "@/server/principal";
import { schoolI18n } from "@/server/school";
import { getProgressSummary } from "@/server/services/progress";
import { assertCanViewStudent } from "@/server/services/students";

export const metadata = { title: "Progress report" };

/** Printable progress report for the student, their instructor or the office. Not an exam result. */
export default async function ProgressReport({ params }: { params: Promise<{ studentId: string }> }) {
  const { studentId } = await params;
  const actor = await requireSchoolPage();
  const { t, f, locale, school } = await schoolI18n(actor.schoolId);
  const d = await withTenant(actor.schoolId, async (tx) => {
    try {
      await assertCanViewStudent(tx, userPrincipal(actor), studentId);
    } catch (e) {
      if (e instanceof ForbiddenError) return null;
      throw e;
    }
    const s = await one<{ first_name: string; last_name: string; student_number: string; license_category: string; erased_at: Date | null }>(
      tx,
      `SELECT first_name, last_name, student_number, license_category, erased_at FROM students WHERE id = $1`,
      [studentId],
    );
    if (!s || s.erased_at) return null;
    return {
      s,
      progress: await getProgressSummary(tx, studentId, locale),
      totals: (await one<{ lessons: number; hours: number }>(
        tx,
        `SELECT count(*)::int AS lessons, COALESCE(round(sum(extract(epoch FROM end_time - start_time)) / 3600.0, 1), 0)::float AS hours
           FROM lessons WHERE student_id = $1 AND status = 'completed'`,
        [studentId],
      ))!,
      // Only feedback the instructor shared with the student; internal notes never appear here.
      feedback: await many<{ lesson_number: number; start_time: Date; strengths: string | null; next_focus: string | null }>(
        tx,
        `SELECT l.lesson_number, l.start_time, fb.strengths, fb.next_focus
           FROM lesson_feedback fb JOIN lessons l ON l.id = fb.lesson_id
          WHERE fb.student_id = $1 AND fb.visible_to_student ORDER BY l.start_time DESC LIMIT 3`,
        [studentId],
      ),
    };
  });
  if (!d) return <main className="container"><p>{t("common.notFound")}</p></main>;
  const p = d.progress;
  const back = actor.role === "student" ? "/student" : `/students/${studentId}`;
  return (
    <main className="container invoice" style={{ maxWidth: 760 }}>
      <p className="no-print"><Link href={back}>← {t("report.back")}</Link> · <span className="muted small">{t("report.print")}</span></p>
      <article className="card">
        <div className="spread" style={{ alignItems: "flex-start" }}>
          <div>
            <h1 style={{ marginBottom: 4 }}>{t("report.title")}</h1>
            <div>{d.s.first_name} {d.s.last_name} · {d.s.student_number} · {d.s.license_category}</div>
          </div>
          <div style={{ textAlign: "end" }}>
            <strong>{school.name}</strong>
            <div className="small muted">{t("report.generated", { date: f.shortDate(new Date()) })}</div>
          </div>
        </div>
        <p className="small" style={{ border: "1px solid var(--border)", borderRadius: 8, padding: 8, marginTop: 12 }}>{t("report.disclaimer", { school: school.name })}</p>
        <dl className="kv">
          <dt>{t("report.level")}</dt>
          <dd>{p.currentLevel ? `${p.currentLevel.name} (${p.currentLevel.position}/${p.totalLevels})` : "–"} {!p.levelConfirmed && p.currentLevel && <span className="muted small">{t("report.unconfirmed")}</span>}</dd>
          <dt>{t("report.lessons")}</dt><dd>{d.totals.lessons}</dd>
          <dt>{t("report.hours")}</dt><dd>{d.totals.hours}</dd>
        </dl>
        <ProgressBar value={p.percent} label={t("report.title")} />
        <div className="grid two" style={{ marginTop: 12 }}>
          <div>
            <h2>{t("report.skillsDone")} ({p.completed.length})</h2>
            <ul className="small">{p.completed.map((n) => <li key={n}>{n}</li>)}</ul>
          </div>
          <div>
            <h2>{t("report.needsWork")} ({p.needsImprovement.length})</h2>
            <ul className="small">{p.needsImprovement.map((n) => <li key={n}>{n}</li>)}</ul>
          </div>
        </div>
        {d.feedback.length > 0 && (
          <>
            <h2>{t("report.recentFeedback")}</h2>
            {d.feedback.map((fb) => (
              <p key={fb.lesson_number} className="small">
                <strong>{t("common.lessonNo", { number: fb.lesson_number })} · {f.shortDate(fb.start_time)}</strong><br />
                {fb.strengths && <>+ {fb.strengths}<br /></>}
                {fb.next_focus && <>→ {fb.next_focus}</>}
              </p>
            ))}
          </>
        )}
      </article>
    </main>
  );
}
