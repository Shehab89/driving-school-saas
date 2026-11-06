import Link from "next/link";
import { Flash, StatusBadge, sp, type SearchParams } from "@/components/ui";
import { Sparkline } from "@/components/charts";
import { RoadJourney } from "@/components/road-journey";
import { CalendarButton } from "@/components/calendar-button";
import { tryTranslate } from "@/i18n";
import { loadStudent } from "./data";
import { withTenant } from "@/lib/db";
import { TopicTags } from "@/components/topic-picker";
import { topicsForLessons } from "@/server/services/topics";
import { Avatar, Milestones, ProgressRing, WhenPill } from "@/components/delight";
import { partOfDay, relativeWhen } from "@/lib/relative-time";
import { studentMilestones } from "@/lib/milestones";

export default async function StudentHome({ searchParams }: { searchParams: SearchParams }) {
  const q = await sp(searchParams);
  const { actor, d, t, f, locale, school } = await loadStudent();
  const nowDate = new Date();
  const next = d.upcoming[0];
  const nextTopics = next ? ((await withTenant(actor.schoolId, (tx) => topicsForLessons(tx, [next.id], locale))).get(next.id)?.planned ?? []) : [];
  const level = d.progress.currentLevel;
  const open = d.payments.filter((p) => ["pending", "overdue", "failed"].includes(p.status));
  const fb = d.latestFeedback;
  const bookPrice = t("student.bookIntro", {
    transmission: d.student.preferred_transmission === "automatic" ? t("student.automatic").toLowerCase() : t("student.manual").toLowerCase(),
    minutes: d.booking.minutes,
    price: f.money(d.booking.priceCents, d.currency),
  });
  const ratings = d.ratings;
  const avg = ratings.length ? ratings.reduce((a, r) => a + r.rating, 0) / ratings.length : null;
  const num = (v: number) => f.number(v);
  const live = next ? new Date(next.start_time) <= nowDate : false;
  const milestones = studentMilestones({
    lessons: d.driven.lessons,
    minutes: d.driven.minutes,
    ratings: ratings.map((r) => r.rating),
    levelPosition: level?.position ?? null,
    totalLevels: d.progress.totalLevels,
  });
  const earned = milestones.filter((m) => m.earned).length;

  return (
    <>
      <div className="page-head" style={{ display: "block" }}>
        <span className="eyebrow">{f.date(nowDate)}</span>
        <h1 style={{ marginTop: 2 }}>{t(`student.home.greet.${partOfDay(nowDate, school.timezone)}`, { name: d.student.first_name })}</h1>
      </div>
      <Flash searchParams={q} />

      <section className="ticket" aria-labelledby="next-h">
        <div className="spread">
          <span className="eyebrow" id="next-h">{t("student.upcomingLesson")}</span>
          {next && <WhenPill live={live}>{live ? t("student.home.now") : relativeWhen(new Date(next.start_time), nowDate, f.tag, school.timezone)}</WhenPill>}
        </div>
        {next ? (
          <>
            <p className="hero-time num">{f.range(next.start_time, next.end_time)}</p>
            <p className="ticket-date">{f.date(next.start_time)}</p>
            <div className="ticket-person">
              <Avatar name={next.instructor_name} size={40} />
              <span>
                <strong>{next.instructor_name}</strong>
                <span className="sub">{t("common.lessonNo", { number: next.lesson_number })} · {next.vehicle ?? t("common.noVehicle")}</span>
              </span>
            </div>
            {nextTopics.length > 0 && <p className="ticket-topics"><span className="sub">{t("topics.planned")}: </span><TopicTags topics={nextTopics} /></p>}
            <div className="ticket-actions">
              {next.canReschedule && !next.pendingRequest && <CalendarButton key={next.id} actor={actor} t={t} lessonId={next.id} label={t("student.reschedule")} primary />}
              <a className="btn" href={`/api/lessons/${next.id}/ics`} download>
                <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M4 5h16v15H4zM4 9h16M8 3v4M16 3v4M12 12v5M9.5 14.5h5" /></svg>
                {t("student.home.addToCalendar")}
              </a>
            </div>
            <p className="ticket-note">
              {next.pendingRequest
                ? t("student.rescheduleRequested", { when: f.dateTime(next.pendingRequest.requested_start) })
                : next.canReschedule
                  ? t("student.rescheduleUntil", { when: f.dateTime(next.rescheduleDeadline!) })
                  : (tryTranslate(locale, `errors.${next.rescheduleBlockedCode}`, { hours: d.noticeHours }) ?? next.rescheduleBlockedReason)}
            </p>
          </>
        ) : (
          <>
            <p className="ticket-empty">{t("student.noUpcoming")}</p>
            {d.booking.selfBooking && <CalendarButton actor={actor} t={t} lessonId={null} label={t("student.bookOne")} primary price={bookPrice} />}
          </>
        )}
      </section>
      {next && d.booking.selfBooking && (
        <div style={{ marginBottom: 12 }}>
          <CalendarButton actor={actor} t={t} lessonId={null} label={t("student.bookOne")} price={bookPrice} block />
        </div>
      )}

      <section className="card" aria-labelledby="level-h">
        <div className="spread" style={{ marginBottom: 8 }}>
          <span className="eyebrow" id="level-h">{t("student.home.readiness")}</span>
          {level && !d.progress.levelConfirmed && <StatusBadge value="suggested" t={t} />}
        </div>
        <div className="readiness">
          <ProgressRing value={d.progress.percent} label={t("student.home.readiness") + ": " + Math.round(d.progress.percent * 100) + "%"}>
            <strong className="num" dir="ltr">{Math.round(d.progress.percent * 100)}%</strong>
          </ProgressRing>
          <div className="readiness-text">
            {level ? (
              <>
                <strong>{level.name}</strong>
                <span className="muted small">{t("student.home.levelOf", { position: level.position, total: d.progress.totalLevels })}</span>
              </>
            ) : (
              <span className="muted">{t("student.levelPending")}</span>
            )}
          </div>
        </div>
        <dl className="mini-stats">
          <div><dt>{t("student.stats.lessons")}</dt><dd className="num">{d.driven.lessons}</dd></div>
          <div><dt>{t("student.stats.hours")}</dt><dd className="num">{num(d.driven.minutes / 60)}</dd></div>
          <div><dt>{t("student.stats.rating")}</dt><dd className="num">{avg === null ? "–" : <>{num(avg)} <span className="star">★</span></>}</dd></div>
        </dl>
        {d.progress.levels.length > 0 && (
          <>
            <RoadJourney
              levels={d.progress.levels}
              currentPosition={level?.position ?? null}
              percent={d.progress.percent}
              labels={{
                title: t("student.journey.title"),
                start: t("student.journey.start"),
                exam: t("student.journey.exam"),
                you: t("student.journey.you"),
                level: (position, name, done, total) => `${t("student.journey.levelN", { position })} · ${name} · ${t("student.journey.skills", { done, total })}`,
              }}
            />
            <details className="ch-table">
              <summary>{t("student.journey.allLevels")}</summary>
              <ol className="journey-levels">
                {d.progress.levels.map((l) => (
                  <li key={l.position} className={l.position === level?.position ? "current" : undefined}>
                    <span className="num muted">{l.position}</span>
                    <span>{l.name}</span>
                    <span className="ch-bl-track" aria-hidden><span className="ch-bl-bar" style={{ width: `${l.total ? (l.done / l.total) * 100 : 0}%` }} /></span>
                    <span className="num muted small" dir="ltr">{l.done}/{l.total}</span>
                  </li>
                ))}
              </ol>
            </details>
          </>
        )}
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

      {fb?.next_focus && (
        <section className="card focus-card" aria-labelledby="focus-h">
          <span className="focus-icon" aria-hidden="true">
            <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M12 21a9 9 0 1 1 0-18 9 9 0 0 1 0 18zM12 16a4 4 0 1 1 0-8 4 4 0 0 1 0 8zM12 12h.01" /></svg>
          </span>
          <div>
            <span className="eyebrow" id="focus-h">{t("student.home.focusTitle")}</span>
            <p style={{ margin: "4px 0 0", fontWeight: 600 }}>{fb.next_focus}</p>
            <p className="muted small" style={{ margin: "2px 0 0" }}>{fb.instructor_name} · {f.shortDate(fb.start_time)}</p>
          </div>
        </section>
      )}

      <section className="card" aria-labelledby="ms-h">
        <div className="spread" style={{ marginBottom: 10 }}>
          <span className="eyebrow" id="ms-h">{t("student.home.milestones")}</span>
          <span className="small muted num">{t("student.home.milestonesCount", { earned, total: milestones.length })}</span>
        </div>
        <Milestones
          items={milestones}
          label={t("student.home.milestones")}
          labelFor={(m) => ({ title: t(`student.home.badges.${m.key}.title`), hint: m.progress && !m.earned ? `${t(`student.home.badges.${m.key}.hint`)} · ${m.progress[0]}/${m.progress[1]}` : t(`student.home.badges.${m.key}.hint`) })}
        />
      </section>

      <section className="card" aria-labelledby="fb-h">
        <div className="spread" style={{ marginBottom: 10 }}>
          <span className="eyebrow" id="fb-h">{t("student.feedback")}</span>
          {fb && !fb.seen_at && <span className="badge new">{t("common.new")}</span>}
        </div>
        {ratings.length > 1 && (
          <div className="spread" style={{ alignItems: "center", marginBottom: 10 }}>
            <span className="muted small">{t("student.stats.ratingTrend", { count: ratings.length })}</span>
            <Sparkline
              values={ratings.map((r) => r.rating)}
              tips={ratings.map((r) => t("student.stats.ratingTip", { number: r.lesson_number, rating: r.rating }))}
              min={1}
              max={5}
              width={120}
              height={32}
              ariaLabel={t("student.stats.ratingTrend", { count: ratings.length })}
            />
          </div>
        )}
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
