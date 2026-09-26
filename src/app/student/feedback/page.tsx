import { withTenant } from "@/lib/db";
import { requireSchoolPage } from "@/server/auth/session";
import { userPrincipal } from "@/server/principal";
import { schoolI18n } from "@/server/school";
import { feedbackForStudent, markFeedbackSeen } from "@/server/services/feedback";

export default async function StudentFeedback() {
  const actor = await requireSchoolPage("lessons:request_reschedule");
  const { t, f } = await schoolI18n(actor.schoolId);
  // Read first (so "New" shows on this visit), then mark as read for next time.
  const items = await withTenant(actor.schoolId, async (tx) => {
    const list = await feedbackForStudent(tx, actor.studentId!);
    await markFeedbackSeen(tx, userPrincipal(actor), actor.studentId!);
    return list;
  });
  return (
    <>
      <div className="page-head" style={{ display: "block" }}>
        <h1>{t("student.feedbackTitle")}</h1>
        <p className="muted" style={{ margin: 0 }}>{t("student.feedbackIntro")}</p>
      </div>
      {items.length === 0 && <div className="card empty">{t("student.feedbackPageEmpty")}</div>}
      {items.map((fb) => (
        <article key={fb.lesson_id} className="card fb-card">
          <div className="spread">
            <div>
              <span className="eyebrow">{f.date(fb.start_time)}</span>
              <div style={{ fontWeight: 700 }}>
                {t("common.lessonNo", { number: fb.lesson_number })} · {fb.instructor_name}
              </div>
            </div>
            <div className="row">
              {!fb.seen_at && <span className="badge new">{t("common.new")}</span>}
              {fb.overall_rating && (
                <span className="stars" aria-label={`${t("student.rating")}: ${fb.overall_rating}/5`}>
                  {"★".repeat(fb.overall_rating)}
                  <span className="off">{"★".repeat(5 - fb.overall_rating)}</span>
                </span>
              )}
            </div>
          </div>
          <div className="fb-grid">
            {fb.strengths && <div className="fb-item good"><h3>{t("student.wentWell")}</h3><p>{fb.strengths}</p></div>}
            {fb.weaknesses && <div className="fb-item improve"><h3>{t("student.toImprove")}</h3><p>{fb.weaknesses}</p></div>}
            {fb.practice_items && <div className="fb-item"><h3>{t("student.toPractice")}</h3><p>{fb.practice_items}</p></div>}
            {fb.next_focus && <div className="fb-item focus"><h3>{t("student.nextFocus")}</h3><p>{fb.next_focus}</p></div>}
          </div>
        </article>
      ))}
    </>
  );
}
