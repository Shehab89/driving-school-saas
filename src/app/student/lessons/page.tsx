import Link from "next/link";
import { StatusBadge } from "@/components/ui";
import { durationMinutes } from "@/lib/time";
import { loadStudent } from "../data";

export default async function StudentLessons() {
  const { d, t, f } = await loadStudent();
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
            </div>
            {l.canReschedule ? (
              <Link className="btn" href={`/student/lessons/${l.id}/reschedule`}>{t("student.reschedule")}</Link>
            ) : (
              <StatusBadge value={l.status} t={t} />
            )}
          </div>
        ))}
      </section>
      <section className="card">
        <h2>{t("student.lessonHistory")}</h2>
        {d.history.length === 0 ? (
          <p className="muted">{t("student.noHistory")}</p>
        ) : (
          <div className="table-wrap">
            <table className="stack-table">
              <thead>
                <tr><th>{t("common.lesson")}</th><th>{t("common.date")}</th><th>{t("common.instructor")}</th><th>{t("common.duration")}</th><th>{t("student.feedback")}</th><th>{t("student.paymentsTitle")}</th></tr>
              </thead>
              <tbody>
                {d.history.map((l) => (
                  <tr key={l.id}>
                    <td data-label={t("common.lesson")}>#{l.lesson_number} <StatusBadge value={l.status} t={t} /></td>
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
