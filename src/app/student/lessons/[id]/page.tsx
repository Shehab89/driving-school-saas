import { Fragment } from "react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { one, withTenant } from "@/lib/db";
import { Flash, StatusBadge, Stars, sp, type SearchParams } from "@/components/ui";
import { TopicTags } from "@/components/topic-picker";
import { requireSchoolActor, requireSchoolPage } from "@/server/auth/session";
import { userPrincipal } from "@/server/principal";
import { schoolI18n } from "@/server/school";
import { getI18n } from "@/i18n/server";
import { ownReview, saveLessonReview } from "@/server/services/reviews";
import { topicsForLessons } from "@/server/services/topics";
import { idOr404, num, runAction, str } from "@/server/web";

async function reviewAction(fd: FormData) {
  "use server";
  const { t } = await getI18n();
  const lessonId = str(fd, "lessonId");
  await runAction(async () => {
    const actor = await requireSchoolActor("lessons:request_reschedule");
    await withTenant(actor.schoolId, (tx) => saveLessonReview(tx, userPrincipal(actor), lessonId, { rating: num(fd, "rating") ?? 0, comment: str(fd, "comment") }));
  }, { back: `/student/lessons/${lessonId}`, okMessage: t("review.sent") });
}

/** One lesson for the student: the instructor's notes, the topics, and the student's own review. */
export default async function StudentLesson({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: SearchParams }) {
  const id = idOr404((await params).id);
  const q = await sp(searchParams);
  const actor = await requireSchoolPage("lessons:request_reschedule");
  const { t, f, locale } = await schoolI18n(actor.schoolId);
  const d = await withTenant(actor.schoolId, async (tx) => {
    const l = await one<{ id: string; student_id: string; lesson_number: number; start_time: Date; end_time: Date; status: string; instructor_name: string; vehicle: string | null }>(
      tx,
      `SELECT l.id, l.student_id, l.lesson_number, l.start_time, l.end_time, l.status, i.first_name || ' ' || i.last_name AS instructor_name,
              CASE WHEN v.id IS NULL THEN NULL ELSE v.brand || ' ' || v.model END AS vehicle
         FROM lessons l JOIN instructors i ON i.id = l.instructor_id LEFT JOIN vehicles v ON v.id = l.vehicle_id WHERE l.id = $1`,
      [id],
    );
    if (!l || l.student_id !== actor.studentId) return null;
    const fb = await one<{ overall_rating: number | null; strengths: string | null; weaknesses: string | null; practice_items: string | null; next_focus: string | null }>(
      tx,
      `SELECT overall_rating, strengths, weaknesses, practice_items, next_focus FROM lesson_feedback WHERE lesson_id = $1 AND visible_to_student`,
      [id],
    );
    const topics = (await topicsForLessons(tx, [id], locale)).get(id) ?? { planned: [], covered: [] };
    const review = await ownReview(tx, userPrincipal(actor), id);
    return { l, fb, topics, review };
  });
  if (!d) notFound();
  const { l, fb, topics, review } = d;
  return (
    <>
      <p><Link href="/student/lessons"><span className="flip">←</span> {t("review.back")}</Link></p>
      <div className="page-head" style={{ display: "block" }}>
        <span className="eyebrow">{f.date(l.start_time)} · <span className="num">{f.range(l.start_time, l.end_time)}</span></span>
        <h1 style={{ marginTop: 4 }}>{t("common.lessonNo", { number: l.lesson_number })}</h1>
        <p className="muted" style={{ margin: 0 }}>{l.instructor_name} · {l.vehicle ?? t("common.noVehicle")} <StatusBadge value={l.status} t={t} /></p>
      </div>
      <Flash searchParams={q} />
      {(topics.planned.length > 0 || topics.covered.length > 0) && (
        <section className="card">
          {topics.covered.length > 0 && <p style={{ margin: "0 0 6px" }}><span className="muted small">{t("topics.covered")}: </span><TopicTags topics={topics.covered} /></p>}
          {topics.planned.length > 0 && <p style={{ margin: 0 }}><span className="muted small">{t("topics.planned")}: </span><TopicTags topics={topics.planned} /></p>}
        </section>
      )}
      <section className="card fb-card">
        <div className="spread">
          <h2 style={{ margin: 0 }}>{t("review.instructorNotes")}</h2>
          {fb?.overall_rating ? <Stars value={fb.overall_rating} /> : null}
        </div>
        {fb && (fb.strengths || fb.weaknesses || fb.practice_items || fb.next_focus) ? (
          <div className="fb-grid">
            {fb.strengths && <div className="fb-item good"><h3>{t("student.wentWell")}</h3><p>{fb.strengths}</p></div>}
            {fb.weaknesses && <div className="fb-item improve"><h3>{t("student.toImprove")}</h3><p>{fb.weaknesses}</p></div>}
            {fb.practice_items && <div className="fb-item"><h3>{t("student.toPractice")}</h3><p>{fb.practice_items}</p></div>}
            {fb.next_focus && <div className="fb-item focus"><h3>{t("student.nextFocus")}</h3><p>{fb.next_focus}</p></div>}
          </div>
        ) : (
          <p className="muted">{t("review.noNotes")}</p>
        )}
      </section>
      {l.status === "completed" && (
        <section className="card">
          <h2>{review ? t("review.title") : t("review.ask")}</h2>
          <form action={reviewAction}>
            <input type="hidden" name="lessonId" value={l.id} />
            <div className="star-input" role="radiogroup" aria-label={t("review.stars")} style={{ marginBottom: 12 }}>
              {[5, 4, 3, 2, 1].map((n) => (
                <Fragment key={n}>
                  <input type="radio" id={`rv${n}`} name="rating" value={n} required defaultChecked={review?.rating === n} />
                  <label htmlFor={`rv${n}`} aria-label={`${n}/5`}>★</label>
                </Fragment>
              ))}
            </div>
            <div className="field">
              <label htmlFor="comment">{t("review.note")}</label>
              <textarea id="comment" name="comment" rows={3} maxLength={2000} defaultValue={review?.comment ?? ""} placeholder={t("review.noteHint")} />
            </div>
            <p className="muted small">{t("review.sentNote")}</p>
            <button className="primary block" type="submit">{review ? t("review.update") : t("review.send")}</button>
          </form>
        </section>
      )}
    </>
  );
}
