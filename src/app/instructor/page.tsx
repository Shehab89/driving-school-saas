import Link from "next/link";
import { DateTime } from "luxon";
import { withTenant } from "@/lib/db";
import { LessonCard } from "@/components/calendar";
import { Flash, StatusBadge, sp, type SearchParams } from "@/components/ui";
import { getI18n } from "@/i18n/server";
import { requireSchoolActor } from "@/server/auth/session";
import { listCalendarLessons } from "@/server/services/lessons";
import { makeOwnerAnInstructor } from "@/server/services/staff";
import { userPrincipal } from "@/server/principal";
import { runAction } from "@/server/web";
import { loadInstructor } from "./data";
import { waitingFeedbackCount } from "@/server/services/feedback";

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
  const { actor, t, f, school } = await loadInstructor();
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
  const [today, tomorrow, waiting] = await withTenant(actor.schoolId, async (tx) => [
    await listCalendarLessons(tx, { from: now.startOf("day").toJSDate(), to: now.endOf("day").toJSDate(), instructorId: actor.instructorId }),
    await listCalendarLessons(tx, { from: now.plus({ days: 1 }).startOf("day").toJSDate(), to: now.plus({ days: 1 }).endOf("day").toJSDate(), instructorId: actor.instructorId }),
    await waitingFeedbackCount(tx, actor.instructorId!),
  ] as const);
  const active = today.filter((l) => !["cancelled"].includes(l.status));
  const nextUp = active.find((l) => ["scheduled", "confirmed", "in_progress"].includes(l.status) && new Date(l.end_time) > now.toJSDate());

  return (
    <>
      <div className="page-head" style={{ display: "block" }}>
        <span className="eyebrow">{f.date(now.toJSDate())}</span>
        <h1 style={{ marginTop: 2, marginBottom: 2 }}>{t("instructor.todayTitle")}</h1>
        <p className="muted" style={{ margin: 0 }}>{active.length ? t("instructor.lessonsToday", { count: active.length }) : t("instructor.noLessonsToday")}</p>
      </div>
      <Flash searchParams={q} />
      {waiting > 0 && (
        <Link href="/instructor/feedback" className="card spread" style={{ display: "flex", color: "inherit", textDecoration: "none", background: "var(--accent-soft)", borderColor: "transparent" }}>
          <strong>{t("instructor.feedback.waiting")}</strong>
          <span className="badge new">{waiting}</span>
        </Link>
      )}

      {nextUp && (
        <section className="card hero-lesson" aria-labelledby="next-h">
          <div className="spread">
            <span className="eyebrow" id="next-h">{t("instructor.nextUp")}</span>
            <StatusBadge value={nextUp.status} t={t} />
          </div>
          <p className="hero-time num">{f.range(nextUp.start_time, nextUp.end_time)}</p>
          <p style={{ margin: "2px 0" }}><strong>{nextUp.student_name}</strong> · {t("common.lessonNo", { number: nextUp.lesson_number })}</p>
          <p className="muted small">
            {nextUp.level_position ? t("common.level", { position: nextUp.level_position }) : t("common.levelNotSet")} · {nextUp.vehicle ?? t("common.noVehicle")}
          </p>
          <div className="row">
            <Link className="btn primary" href={`/lessons/${nextUp.id}`}>{t("instructor.openLesson")}</Link>
            {nextUp.student_phone && <a className="btn" href={`tel:${nextUp.student_phone}`}>{t("instructor.call")}</a>}
          </div>
        </section>
      )}

      {today.filter((l) => l.id !== nextUp?.id).map((l) => <LessonCard key={l.id} l={l} t={t} f={f} />)}

      <h2 style={{ marginTop: 20 }}>{t("instructor.tomorrow")}</h2>
      {tomorrow.length === 0 ? <p className="muted">{t("instructor.calendar.noLessons")}</p> : tomorrow.map((l) => <LessonCard key={l.id} l={l} t={t} f={f} />)}
    </>
  );
}
