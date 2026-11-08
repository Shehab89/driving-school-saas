import Link from "next/link";
import { ScheduleBoard } from "@/components/schedule-board";
import { Flash, sp, type SearchParams } from "@/components/ui";
import { loadBoard } from "@/server/schedule";
import { requireInstructorProfile } from "../data";

export default async function InstructorCalendar({ searchParams }: { searchParams: SearchParams }) {
  const q = await sp(searchParams);
  const { actor, t, f, school } = await requireInstructorProfile();
  const board = await loadBoard({
    actor,
    zone: school.timezone,
    t,
    f,
    view: q.view,
    date: q.date,
    instructorId: actor.instructorId,
    basePath: "/instructor/calendar",
    showInstructor: false,
  });
  return (
    <>
      <Flash searchParams={q} />
      <p style={{ margin: "0 0 8px", textAlign: "end" }}><Link className="btn primary sm" href="/instructor/lessons/new">+ {t("instructor.plan.title")}</Link></p>
      <ScheduleBoard {...board} />
    </>
  );
}
