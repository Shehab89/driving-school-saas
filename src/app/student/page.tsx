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
      <div className="page-head" style={{ display: "block" }}>
        <span className="eyebrow">{f.date(new Date())}</span>
        <h1 style={{ marginTop: 2 }}>{t("student.hi", { name: d.student.first_name })}</h1>
      </div>
      <Flash searchParams={q} />

      <section className="card hero-lesson" aria-labelledby="next-h">
        <span className="eyebrow" id="next-h">{t("student.upcomingLesson")}</span>
        {next ? (
          <>
            <p className="hero-time num">{f.range(next.start_time, next.end_time)}</p>
            <p style={{ fontWeight: 700, margin: 0 }}>{f.date(next.start_time)}</p>
            <p className="muted" style={{ margin: "4px 0 14px" }}>
              {t("common.lessonNo", { number: next.lesson_number })} · {next.instructor_name} · {next.vehicle ?? t("common.noVehicle")}
            </p>
            {next.pendingRequest ? (
              <p className="muted small">{t("student.rescheduleRequested", { when: f.dateTime(next.pendingRequest.requested_start) })}</p>
            ) : next.canReschedule ? (
              <div className="row">
                <Link className="btn primary" href={`/student/lessons/${next.id}/reschedule`}>{t("student.reschedule")}</Link>
                <span className="muted small">{t("student.rescheduleUntil", { when: f.dateTime(next.rescheduleDeadline!) })}</span>
              </div>
            ) : (
              <p className="muted small" style={{ margin: 0 }}>
                {tryTranslate(locale, `errors.${next.rescheduleBlockedCode}`, { hours: d.noticeHours }) ?? next.rescheduleBlockedReason}
              </p>
            )}
          </>
        ) : (
          <>
            <p className="muted" style={{ margin: "8px 0 12px" }}>{t("student.noUpcoming")}</p>
            {d.booking.selfBooking && <Link className="btn primary" href="/student/book">{t("student.bookOne")}</Link>}
          </>
        )}
      </section>

      <section className="card" aria-labelledby="level-h">
        <div className="spread" style={{ marginBottom: 8 }}>
          <span className="eyebrow" id="level-h">{t("student.drivingLevel")}</span>
          {level && !d.progress.levelConfirmed && <StatusBadge value="suggested" t={t} />}
        </div>
        {level ? (
          <div className="spread" style={{ alignItems: "flex-end", marginBottom: 10 }}>
            <div>
              <div style={{ fontSize: "1.9rem", fontWeight: 800, letterSpacing: "-0.03em" }} className="num" dir="ltr">
                {level.position}<span className="muted" style={{ fontSize: "1.1rem" }}> / {d.progress.totalLevels}</span>
              </div>
              <div className="muted">{level.name}</div>
            </div>
            <strong className="num" dir="ltr">{Math.round(d.progress.percent * 100)}%</strong>
          </div>
        ) : (
          <p className="muted">{t("student.levelPending")}</p>
        )}
        <ProgressBar value={d.progress.percent} label={t("student.progress")} />
        {(d.progress.completed.length > 0 || d.progress.needsImprovement.length > 0) && (
          <div className="chips" style={{ marginTop: 14 }}>
            {d.progress.needsImprovement.map((s) => (
              <span key={s} className="badge warning">{s}</span>
            ))}
            {d.progress.completed.slice(-6).map((s) => (
              <span key={s} className="badge success">{s}</span>
            ))}
          </div>
        )}
      </section>

      <section className="card" aria-labelledby="fb-h">
        <div className="spread" style={{ marginBottom: 10 }}>
          <span className="eyebrow" id="fb-h">{t("student.feedback")}</span>
          {fb && !fb.seen_at && <span className="badge new">{t("common.new")}</span>}
        </div>
        {fb ? (
          <>
            <p className="muted small">
              {t("student.feedbackFrom", { lesson: t("common.lessonNo", { number: fb.lesson_number }), date: f.shortDate(fb.start_time), instructor: fb.instructor_name })}
            </p>
            <div className="fb-grid">
              {fb.strengths && <div className="fb-item good"><h3>{t("student.wentWell")}</h3><p>{fb.strengths}</p></div>}
              {fb.weaknesses && <div className="fb-item improve"><h3>{t("student.toImprove")}</h3><p>{fb.weaknesses}</p></div>}
              {fb.next_focus && <div className="fb-item focus"><h3>{t("student.nextFocus")}</h3><p>{fb.next_focus}</p></div>}
            </div>
            <Link className="btn block" href="/student/feedback" style={{ marginTop: 12 }}>{t("student.feedbackAll", { count: fb.total })}</Link>
          </>
        ) : (
          <p className="muted">{t("student.feedbackEmpty")}</p>
        )}
      </section>

      <Link href="/student/payments" className="card spread" style={{ color: "inherit", display: "flex", textDecoration: "none" }}>
        <span className="eyebrow">{t("student.paymentsTitle")}</span>
        <span className={open.length ? "badge warning" : "badge success"}>
          {open.length ? t("student.openPayments", { count: open.length, amount: f.money(open.reduce((a, p) => a + p.amount_cents, 0), d.currency) }) : t("student.allPaid")}
        </span>
      </Link>
    </>
  );
}
