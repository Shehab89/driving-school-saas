import { withTenant } from "@/lib/db";
import { Calendar, type CalendarView } from "@/components/calendar";
import { sp, type SearchParams } from "@/components/ui";
import { calendarRange, listCalendarLessons } from "@/server/services/lessons";
import { requireInstructorProfile } from "../data";

export default async function InstructorCalendar({ searchParams }: { searchParams: SearchParams }) {
  const q = await sp(searchParams);
  const { actor, t, f, school } = await requireInstructorProfile();
  const view = (["day", "week", "month"].includes(q.view ?? "") ? q.view : "week") as CalendarView;
  const { start, end, anchor } = calendarRange(view, q.date ?? "", school.timezone);
  const lessons = await withTenant(actor.schoolId, (tx) => listCalendarLessons(tx, { from: start.toJSDate(), to: end.toJSDate(), instructorId: actor.instructorId }));
  return <Calendar lessons={lessons} view={view} anchor={anchor} start={start} end={end} basePath="/instructor/calendar" t={t} f={f} />;
}
