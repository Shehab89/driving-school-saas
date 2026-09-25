import Link from "next/link";
import { withTenant } from "@/lib/db";
import { Calendar, type CalendarView } from "@/components/calendar";
import { Flash, sp, type SearchParams } from "@/components/ui";
import { requireSchoolActor, requireSchoolPage } from "@/server/auth/session";
import { calendarRange, listCalendarLessons } from "@/server/services/lessons";
import { makeOwnerAnInstructor } from "@/server/services/staff";
import { userPrincipal } from "@/server/principal";
import { schoolHeader } from "@/server/school";
import { runAction } from "@/server/web";

async function becomeInstructor() {
  "use server";
  await runAction(async () => {
    const actor = await requireSchoolActor();
    await withTenant(actor.schoolId, (tx) => makeOwnerAnInstructor(tx, userPrincipal(actor)));
  }, { back: "/instructor", okMessage: "You now have your own instructor calendar." });
}

export default async function InstructorCalendar({ searchParams }: { searchParams: SearchParams }) {
  const q = await sp(searchParams);
  const actor = await requireSchoolPage("lessons:operate_own");
  const school = await schoolHeader(actor.schoolId);
  if (!actor.instructorId) {
    return (
      <div className="card narrow">
        <h1>No instructor profile</h1>
        <p>Your account is not linked to an instructor. If you teach lessons yourself, create your instructor profile.</p>
        <form action={becomeInstructor}><button className="primary">I also teach – create my calendar</button></form>
        <p className="small muted" style={{ marginTop: 8 }}>Or see the <Link href="/admin/calendar">school calendar</Link>.</p>
      </div>
    );
  }
  const view = (["day", "week", "month"].includes(q.view ?? "") ? q.view : "day") as CalendarView;
  const { start, end, anchor } = calendarRange(view, q.date ?? "", school.timezone);
  const lessons = await withTenant(actor.schoolId, (tx) =>
    listCalendarLessons(tx, { from: start.toJSDate(), to: end.toJSDate(), instructorId: actor.instructorId }),
  );
  return (
    <>
      <Flash searchParams={q} />
      <Calendar lessons={lessons} view={view} anchor={anchor} start={start} end={end} tz={school.timezone} basePath="/instructor" />
    </>
  );
}
