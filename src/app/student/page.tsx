import Link from "next/link";
import { Flash, ProgressBar, StatusBadge, sp, type SearchParams } from "@/components/ui";
import { tryTranslate } from "@/i18n";
import { loadStudent } from "./data";

export default async function StudentHome({ searchParams }: { searchParams: SearchParams }) {
  const q = await sp(searchParams);
  const { d, t, f, locale } = await loadStudent();
  const next = d.upcoming[0];
  const level = d.progress.currentLevel;
  const open = d.payments.filter((p) => ["pending", "overdue", "failed"].includes(p.status));
  const fb = d.latestFeedback;

  return (
    <>
      <h1>{t("student.hi", { name: d.student.first_name })}</h1>
      <Flash searchParams={q} />

      <section className="card hero-lesson" aria-labelledby="next-h">
        <h2 id="next-h">{t("student.upcomingLesson")}</h2>
        {next ? (
          <>
            <dl className="kv">
              <dt>{t("common.instructor")}</dt><dd>{next.instructor_name}</dd>
              <dt>{t("common.date")}</dt><dd>{f.date(next.start_time)}</dd>
              <dt>{t("common.time")}</dt><dd className="num">{f.range(next.start_time, next.end_time)}</dd>
              <dt>{t("common.vehicle")}</dt><dd>{next.vehicle ?? t("common.noVehicle")}</dd>
              <dt>{t("common.lesson")}</dt><dd>{t("common.lessonNo", { number: next.lesson_number })}</dd>
            </dl>
            <div style={{ marginTop: 12 }}>
              {next.pendingRequest ? (
                <p className="muted">{t("student.rescheduleRequested", { when: f.dateTime(next.pendingRequest.requested_start) })}</p>
              ) : next.canReschedule ? (
                <>
                  <Link className="btn primary" href={`/student/lessons/${next.id}/reschedule`}>{t("student.reschedule")}</Link>
                  <p className="muted small" style={{ marginTop: 6 }}>{t("student.rescheduleUntil", { when: f.dateTime(next.rescheduleDeadline!) })}</p>
                </>
              ) : (
                <p className="muted small">
                  {tryTranslate(locale, `errors.${next.rescheduleBlockedCode}`, { hours: d.noticeHours }) ?? next.rescheduleBlockedReason}
                </p>
              )}
            </div>
          </>
        ) : (
          <>
            <p className="muted">{t("student.noUpcoming")}</p>
            {d.booking.selfBooking && <Link className="btn primary" href="/student/book">{t("student.bookOne")}</Link>}
          </>
        )}
      </section>

      <section className="card" aria-labelledby="level-h">
        <h2 id="level-h">{t("student.drivingLevel")}</h2>
        {level ? (
          <>
            <div className="spread">
              <strong style={{ fontSize: "1.3rem" }}>{t("common.levelOf", { position: level.position, total: d.progress.totalLevels })}</strong>
              {!d.progress.levelConfirmed && <StatusBadge value="suggested" t={t} />}
            </div>
            <p className="muted">{level.name}</p>
          </>
        ) : (
          <p className="muted">{t("student.levelPending")}</p>
        )}
        <ProgressBar value={d.progress.percent} label={t("student.progress")} />
        <div className="grid two" style={{ marginTop: 12 }}>
          <div>
            <h3>{t("student.skillsCompleted")}</h3>
            {d.progress.completed.length ? <ul>{d.progress.completed.map((s) => <li key={s}>{s}</li>)}</ul> : <p className="muted small">{t("student.noneYet")}</p>}
          </div>
          <div>
            <h3>{t("student.needsImprovement")}</h3>
            {d.progress.needsImprovement.length ? <ul>{d.progress.needsImprovement.map((s) => <li key={s}>{s}</li>)}</ul> : <p className="muted small">{t("student.nothingFlagged")}</p>}
          </div>
        </div>
      </section>

      <section className="card" aria-labelledby="fb-h">
        <h2 id="fb-h">{t("student.feedback")}</h2>
        {fb ? (
          <>
            <p className="muted small">
              {t("student.feedbackFrom", { lesson: t("common.lessonNo", { number: fb.lesson_number }), date: f.date(fb.start_time), instructor: fb.instructor_name })}
            </p>
            <div className="grid two">
              <div><h3>{t("student.wentWell")}</h3><p>{fb.strengths || t("common.none")}</p></div>
              <div><h3>{t("student.toImprove")}</h3><p>{fb.weaknesses || t("common.none")}</p></div>
              <div><h3>{t("student.toPractice")}</h3><p>{fb.practice_items || t("common.none")}</p></div>
              <div><h3>{t("student.nextFocus")}</h3><p>{fb.next_focus || t("common.none")}</p></div>
            </div>
          </>
        ) : (
          <p className="muted">{t("student.feedbackEmpty")}</p>
        )}
      </section>

      <Link href="/student/payments" className="card spread" style={{ color: "inherit", display: "flex" }}>
        <strong>{t("student.paymentsTitle")}</strong>
        <span className={open.length ? "badge warning" : "badge success"}>
          {open.length ? t("student.openPayments", { count: open.length, amount: f.money(open.reduce((a, p) => a + p.amount_cents, 0), d.currency) }) : t("student.allPaid")}
        </span>
      </Link>
    </>
  );
}
