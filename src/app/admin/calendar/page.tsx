import { many, withTenant } from "@/lib/db";
import { Calendar, type CalendarView } from "@/components/calendar";
import { sp, type SearchParams } from "@/components/ui";
import { requireSchoolPage } from "@/server/auth/session";
import { calendarRange, listCalendarLessons } from "@/server/services/lessons";
import { schoolI18n } from "@/server/school";
import Link from "next/link";

export default async function SchoolCalendar({ searchParams }: { searchParams: SearchParams }) {
  const q = await sp(searchParams);
  const actor = await requireSchoolPage("lessons:read_all");
  const { school, t, f } = await schoolI18n(actor.schoolId);
  const view = (["day", "week", "month"].includes(q.view ?? "") ? q.view : "week") as CalendarView;
  const { start, end, anchor } = calendarRange(view, q.date ?? "", school.timezone);
  const instructorId = q.instructor || null;
  const { lessons, instructors } = await withTenant(actor.schoolId, async (tx) => ({
    lessons: await listCalendarLessons(tx, { from: start.toJSDate(), to: end.toJSDate(), instructorId }),
    instructors: await many<{ id: string; name: string }>(tx, `SELECT id, first_name || ' ' || last_name AS name FROM instructors WHERE status = 'active' ORDER BY first_name`),
  }));
  return (
    <>
      <div className="spread">
        <h1>Calendar</h1>
        <Link className="btn primary" href="/admin/lessons/new">Book lesson</Link>
      </div>
      <form className="row" style={{ marginBottom: 12 }}>
        <input type="hidden" name="view" value={view} />
        <input type="hidden" name="date" value={anchor.toISODate()!} />
        <select name="instructor" defaultValue={instructorId ?? ""} aria-label="Instructor" style={{ width: "auto" }}>
          <option value="">All instructors</option>
          {instructors.map((i) => <option key={i.id} value={i.id}>{i.name}</option>)}
        </select>
        <button>Filter</button>
      </form>
      <Calendar lessons={lessons} view={view} anchor={anchor} start={start} end={end} t={t} f={f} basePath="/admin/calendar" extraQuery={instructorId ? `&instructor=${instructorId}` : ""} />
    </>
  );
}
