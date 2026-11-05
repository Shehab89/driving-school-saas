import Link from "next/link";
import { StatusBadge } from "@/components/ui";
import { CalendarButton } from "@/components/calendar-button";
import { durationMinutes } from "@/lib/time";
import { many, withTenant } from "@/lib/db";
import { TopicTags } from "@/components/topic-picker";
import { topicsForLessons } from "@/server/services/topics";
import { loadStudent } from "../data";

export default async function StudentLessons() {
  const { actor, d, t, f, locale } = await loadStudent();
  const { topics, reviewed } = await withTenant(actor.schoolId, async (tx) => ({
    topics: await topicsForLessons(tx, d.upcoming.map((l) => l.id), locale),
    reviewed: new Set((await many<{ lesson_id: string }>(tx, `SELECT lesson_id FROM lesson_reviews WHERE student_id = $1`, [actor.studentId])).map((r) => r.lesson_id)),
  }));
  return (
    <>
      <h1>{t("student.tabs.lessons")}</h1>
      <section className="card">
        <h2>{t("student.upcomingLessons")}</h2>
        {d.upcoming.length === 0 && <p className="muted">{t("student.noUpcoming")}</p>}
        {d.upcoming.map((l) => (
          <div key={l.id} className="list-row">
            <div>
              <strong>{f.shortDate(l.start_time)} · <span className="num">{f.range(l.start_time, l.end_time)}</span></strong>
              <div className="sub">{t("common.lessonNo", { number: l.lesson_number })} · {l.instructor_name} · {l.vehicle ?? t("common.noVehicle")}</div>
              {(topics.get(l.id)?.planned.length ?? 0) > 0 && <div style={{ marginTop: 4 }}><span className="sub">{t("topics.planned")}: </span><TopicTags topics={topics.get(l.id)!.planned} /></div>}
            </div>
            {l.canReschedule ? (
              <CalendarButton actor={actor} t={t} lessonId={l.id} label={t("student.reschedule")} />
            ) : (
              <StatusBadge value={l.status} t={t} />
            )}
          </div>
        ))}
      </section>
      <section className="card">
        <h2>{t("student.lessonHistory")}</h2>
        {d.history.length > 0 && <p className="muted small">{t("review.tapHint")}</p>}
        {d.history.length === 0 ? (
          <p className="muted">{t("student.noHistory")}</p>
        ) : (
          <div className="table-wrap">
            <table className="stack-table">
              <thead>
                <tr><th /><th>{t("common.lesson")}</th><th>{t("common.date")}</th><th>{t("common.instructor")}</th><th>{t("common.duration")}</th><th>{t("student.feedback")}</th><th>{t("student.paymentsTitle")}</th></tr>
              </thead>
              <tbody>
                {d.history.map((l) => (
                  <tr key={l.id}>
                    <td><Link className="btn sm" href={`/student/lessons/${l.id}`}>{t("review.open")}</Link></td>
                    <td data-label={t("common.lesson")}>
                      <Link href={`/student/lessons/${l.id}`}>#{l.lesson_number}</Link> <StatusBadge value={l.status} t={t} />{" "}
                      {l.status === "completed" && (reviewed.has(l.id) ? <span className="badge success">{t("review.reviewed")}</span> : <span className="badge new">{t("review.rate")}</span>)}
                    </td>
                    <td data-label={t("common.date")}>{f.shortDate(l.start_time)}</td>
                    <td data-label={t("common.instructor")}>{l.instructor_name}</td>
                    <td data-label={t("common.duration")} className="num">{durationMinutes(l.start_time, l.end_time)} {t("common.min")}</td>
                    <td data-label={t("student.feedback")} className="small">
                      {l.has_feedback ? (l.next_focus ? t("student.nextPrefix", { focus: l.next_focus }) : (l.strengths ?? "✓")) : t("common.none")}
                    </td>
                    <td data-label={t("student.paymentsTitle")}><StatusBadge value={l.payment_status} t={t} /></td>
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
