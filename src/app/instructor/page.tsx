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
  const [today, tomorrow] = await withTenant(actor.schoolId, async (tx) => [
    await listCalendarLessons(tx, { from: now.startOf("day").toJSDate(), to: now.endOf("day").toJSDate(), instructorId: actor.instructorId }),
    await listCalendarLessons(tx, { from: now.plus({ days: 1 }).startOf("day").toJSDate(), to: now.plus({ days: 1 }).endOf("day").toJSDate(), instructorId: actor.instructorId }),
  ]);
  const active = today.filter((l) => !["cancelled"].includes(l.status));
  const nextUp = active.find((l) => ["scheduled", "confirmed", "in_progress"].includes(l.status) && new Date(l.end_time) > now.toJSDate());

  return (
    <>
      <div className="spread">
        <h1 style={{ margin: 0 }}>{t("instructor.todayTitle")}</h1>
        <span className="muted">{f.date(now.toJSDate())}</span>
      </div>
      <p className="muted">{active.length ? t("instructor.lessonsToday", { count: active.length }) : t("instructor.noLessonsToday")}</p>
      <Flash searchParams={q} />

      {nextUp && (
        <section className="card hero-lesson" aria-labelledby="next-h">
          <div className="spread">
            <h2 id="next-h" style={{ margin: 0 }}>{t("instructor.nextUp")}</h2>
            <StatusBadge value={nextUp.status} t={t} />
          </div>
          <p style={{ fontSize: "1.6rem", fontWeight: 700, margin: "8px 0 0" }} className="num">{f.range(nextUp.start_time, nextUp.end_time)}</p>
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
