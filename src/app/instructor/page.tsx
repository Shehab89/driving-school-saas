import Link from "next/link";
import { Fragment } from "react";
import { DateTime } from "luxon";
import { withTenant } from "@/lib/db";
import { LessonCard } from "@/components/calendar";
import { Avatar, WhenPill } from "@/components/delight";
import { relativeWhen } from "@/lib/relative-time";
import { routeUrl } from "@/lib/travel";
import { Flash, StatusBadge, sp, type SearchParams } from "@/components/ui";
import { getI18n } from "@/i18n/server";
import { requireSchoolActor } from "@/server/auth/session";
import { listCalendarLessons } from "@/server/services/lessons";
import { makeOwnerAnInstructor } from "@/server/services/staff";
import { userPrincipal } from "@/server/principal";
import { runAction } from "@/server/web";
import { loadInstructor } from "./data";
import { waitingFeedbackCount } from "@/server/services/feedback";
import { unplannedStudents } from "@/server/services/attention";
import { ChartTable, ColumnChart } from "@/components/charts";
import { TopicTags } from "@/components/topic-picker";
import { topicsForLessons } from "@/server/services/topics";

async function becomeInstructor() {
  "use server";
  const { t } = await getI18n();
  await runAction(async () => {
    const actor = await requireSchoolActor();
    await withTenant(actor.schoolId, (tx) => makeOwnerAnInstructor(tx, userPrincipal(actor)));
  }, { back: "/instructor", okMessage: t("instructor.flash.calendarCreated") });
}

export default async function InstructorToday({ searchParams }: { searchParams: SearchParams }) {
  const q = await sp(searchParams);
  const { actor, t, f, school, locale } = await loadInstructor();
  if (!actor.instructorId) {
    return (
      <div className="card">
        <h1>{t("instructor.noProfile")}</h1>
        <p>{t("instructor.noProfileText")}</p>
        <form action={becomeInstructor}><button className="primary">{t("instructor.createCalendar")}</button></form>
      </div>
    );
  }
  const now = DateTime.now().setZone(school.timezone);
  const [today, tomorrow, waiting, week, unplanned] = await withTenant(actor.schoolId, async (tx) => [
    await listCalendarLessons(tx, { from: now.startOf("day").toJSDate(), to: now.endOf("day").toJSDate(), instructorId: actor.instructorId }),
    await listCalendarLessons(tx, { from: now.plus({ days: 1 }).startOf("day").toJSDate(), to: now.plus({ days: 1 }).endOf("day").toJSDate(), instructorId: actor.instructorId }),
    await waitingFeedbackCount(tx, actor.instructorId!),
    await listCalendarLessons(tx, { from: now.startOf("week").toJSDate(), to: now.endOf("week").toJSDate(), instructorId: actor.instructorId }),
    (await unplannedStudents(tx, actor.instructorId!, 200)).length,
  ] as const);
  const num = (v: number) => f.number(v);
  const days = Array.from({ length: 7 }, (_, i) => {
    const day = now.startOf("week").plus({ days: i });
    const ls = week.filter((l) => !["cancelled", "rescheduled", "no_show"].includes(l.status) && DateTime.fromJSDate(new Date(l.start_time)).setZone(school.timezone).hasSame(day, "day"));
    const hours = ls.reduce((a, l) => a + (new Date(l.end_time).getTime() - new Date(l.start_time).getTime()) / 3600000, 0);
    return { day, hours, count: ls.length };
  });
  const weekHours = days.reduce((a, d) => a + d.hours, 0);
  const weekCount = days.reduce((a, d) => a + d.count, 0);
  const active = today.filter((l) => !["cancelled"].includes(l.status));
  const nextUp = active.find((l) => ["scheduled", "confirmed", "in_progress"].includes(l.status) && new Date(l.end_time) > now.toJSDate());
  const counted = today.filter((l) => !["cancelled", "rescheduled"].includes(l.status));
  const doneCount = counted.filter((l) => ["completed", "no_show"].includes(l.status)).length;
  const lastEnd = counted.length ? counted.reduce((a, l) => (new Date(l.end_time) > a ? new Date(l.end_time) : a), new Date(0)) : null;
  const nowDate = now.toJSDate();
  const nextLive = nextUp ? new Date(nextUp.start_time) <= nowDate : false;
  const nextTopics = nextUp ? ((await withTenant(actor.schoolId, (tx) => topicsForLessons(tx, [nextUp.id], locale))).get(nextUp.id)?.planned ?? []) : [];

  return (
    <>
      <div className="page-head" style={{ display: "block" }}>
        <span className="eyebrow">{f.date(nowDate)}</span>
        <h1 style={{ marginTop: 2, marginBottom: 2 }}>{t("instructor.todayTitle")}</h1>
        <div className="spread">
          <p className="muted" style={{ margin: 0 }}>{active.length ? t("instructor.lessonsToday", { count: active.length }) : t("instructor.noLessonsToday")}</p>
          <Link className="btn primary sm" href="/instructor/lessons/new">+ {t("instructor.plan.title")}</Link>
        </div>
      </div>
      <Flash searchParams={q} />
      {counted.length > 0 && (
        <div className="day-progress">
          <div className="spread small">
            <strong>{doneCount === counted.length ? t("instructor.home.allDone") : t("instructor.home.dayProgress", { done: doneCount, total: counted.length })}</strong>
            {lastEnd && <span className="muted">{t("instructor.home.endsAt", { time: f.time(lastEnd) })}</span>}
          </div>
          <div className="progress" role="progressbar" aria-valuemin={0} aria-valuemax={counted.length} aria-valuenow={doneCount} aria-label={t("instructor.home.dayProgress", { done: doneCount, total: counted.length })}>
            <span style={{ width: `${(doneCount / counted.length) * 100}%` }} />
          </div>
        </div>
      )}
      {waiting > 0 && (
        <Link href="/instructor/feedback" className="card spread nudge" style={{ display: "flex" }}>
          <strong>{t("instructor.feedback.waiting")}</strong>
          <span className="badge new">{waiting}</span>
        </Link>
      )}
      {unplanned > 0 && (
        <Link href="/instructor/students?show=unplanned" className="card spread nudge" style={{ display: "flex" }} data-testid="unplanned-nudge">
          <strong>{t("instructor.attention.nudge", { count: unplanned })}</strong>
          <span className="badge new">{unplanned}</span>
        </Link>
      )}

      {nextUp && (
        <section className="ticket" aria-labelledby="next-h">
          <div className="spread">
            <span className="eyebrow" id="next-h">{t("instructor.nextUp")}</span>
            <WhenPill live={nextLive}>{nextLive ? t("instructor.home.now") : relativeWhen(new Date(nextUp.start_time), nowDate, f.tag, school.timezone)}</WhenPill>
          </div>
          <p className="hero-time num">{f.range(nextUp.start_time, nextUp.end_time)}</p>
          <div className="ticket-person">
            <Avatar name={nextUp.student_name} size={40} />
            <span>
              <strong>{nextUp.student_name}</strong>
              <span className="sub">
                {t("common.lessonNo", { number: nextUp.lesson_number })} · {nextUp.level_position ? t("common.level", { position: nextUp.level_position }) : t("common.levelNotSet")} · {nextUp.vehicle ?? t("common.noVehicle")}
              </span>
            </span>
          </div>
          {nextUp.pickup_address && (
            <p className="ticket-topics">
              <span className="sub">{t("student.places.meetAt")}: </span>{nextUp.pickup_address}
              {nextUp.pickup_source === "previous_lesson" && <span className="sub"> ({t("instructor.places.samePlace")})</span>}
              {nextUp.dropoff_address && nextUp.dropoff_address !== nextUp.pickup_address && <><br /><span className="sub">{t("student.places.endsAt")}: </span>{nextUp.dropoff_address}</>}
            </p>
          )}
          {nextTopics.length > 0 && <p className="ticket-topics"><span className="sub">{t("topics.planned")}: </span><TopicTags topics={nextTopics} /></p>}
          <div className="ticket-actions">
            <Link className="btn primary" href={`/lessons/${nextUp.id}`}>{t("instructor.openLesson")}</Link>
            {nextUp.pickup_lat !== null && nextUp.pickup_lng !== null && (
              <a className="btn" href={routeUrl({ lat: nextUp.pickup_lat, lng: nextUp.pickup_lng })} target="_blank" rel="noopener">{t("instructor.places.route")}</a>
            )}
            {nextUp.student_phone && <a className="btn" href={`tel:${nextUp.student_phone}`}>{t("instructor.call")}</a>}
          </div>
        </section>
      )}

      {today.length > 0 && (
        <section aria-labelledby="tl-h">
          <h2 id="tl-h" className="sr-only">{t("instructor.home.schedule")}</h2>
          <ol className="timeline">
            {today.map((l, i) => {
              const prev = today.slice(0, i).reverse().find((x) => !["cancelled", "rescheduled"].includes(x.status));
              const gap = prev ? Math.round((new Date(l.start_time).getTime() - new Date(prev.end_time).getTime()) / 60000) : 0;
              const minutes = Math.round((new Date(l.end_time).getTime() - new Date(l.start_time).getTime()) / 60000);
              return (
                <Fragment key={l.id}>
                  {gap >= 15 && <li className="tl-gap">{t("instructor.home.free", { minutes: gap })}{l.travel_minutes_before ? ` · ${t("instructor.places.drive", { minutes: l.travel_minutes_before })}` : ""}</li>}
                  {gap < 15 && prev && l.travel_minutes_before ? <li className="tl-gap">{t("instructor.places.drive", { minutes: l.travel_minutes_before })}</li> : null}
                  <li className={`tl-item ${l.status}${l.id === nextUp?.id ? " next" : ""}`}>
                    <div className="tl-time num"><strong>{f.time(l.start_time)}</strong><span>{minutes} {t("common.min")}</span></div>
                    <span className="tl-dot" aria-hidden="true" />
                    <Link className="tl-card" href={`/lessons/${l.id}`}>
                      <span className="spread"><strong>{l.student_name}</strong><StatusBadge value={l.status} t={t} /></span>
                      <span className="small muted">
                        {t("common.lessonNo", { number: l.lesson_number })} · {l.level_position ? t("common.level", { position: l.level_position }) : t("common.levelNotSet")} · {l.vehicle ?? t("common.noVehicle")}
                      </span>
                      {l.pickup_address && (
                        <span className="small" style={{ display: "block" }}>
                          📍 {l.pickup_address}{l.pickup_source === "previous_lesson" ? ` (${t("instructor.places.samePlace")})` : ""}
                          {l.dropoff_address && l.dropoff_address !== l.pickup_address ? ` → ${l.dropoff_address}` : ""}
                        </span>
                      )}
                    </Link>
                  </li>
                </Fragment>
              );
            })}
          </ol>
        </section>
      )}

      <section className="card" aria-labelledby="week-h">
        <div className="ch-card-head">
          <span className="eyebrow" id="week-h">{t("instructor.week.title")}</span>
          <span className="sub num">{t("instructor.week.summary", { hours: num(weekHours), count: weekCount })}</span>
        </div>
        <ColumnChart
          height={96}
          labelValues="all"
          format={(v) => num(v)}
          ariaLabel={t("instructor.week.title")}
          data={days.map((d) => ({
            key: d.day.toISODate()!,
            label: f.weekdayShort(d.day.weekday),
            value: d.hours,
            highlight: d.day.hasSame(now, "day"),
            tip: t("instructor.week.tip", { day: f.weekday(d.day.weekday), hours: num(d.hours), count: d.count }),
          }))}
        />
        <ChartTable
          summary={t("instructor.week.table")}
          head={[t("instructor.week.day"), t("instructor.week.hours"), t("instructor.week.lessons")]}
          rows={days.map((d) => [f.weekday(d.day.weekday), num(d.hours), d.count])}
        />
      </section>

      <h2 style={{ marginTop: 20 }}>{t("instructor.tomorrow")}</h2>
      {tomorrow.length === 0 ? <p className="muted">{t("instructor.calendar.noLessons")}</p> : tomorrow.map((l) => <LessonCard key={l.id} l={l} t={t} f={f} />)}
    </>
  );
}
