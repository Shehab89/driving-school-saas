import { many, withTenant } from "@/lib/db";
import { ScheduleBoard } from "@/components/schedule-board";
import { loadBoard } from "@/server/schedule";
import { sp, type SearchParams } from "@/components/ui";
import { requireSchoolPage } from "@/server/auth/session";
import { schoolI18n } from "@/server/school";
import Link from "next/link";

export default async function SchoolCalendar({ searchParams }: { searchParams: SearchParams }) {
  const q = await sp(searchParams);
  const actor = await requireSchoolPage("lessons:read_all");
  const { school, t, f } = await schoolI18n(actor.schoolId);
  const instructorId = q.instructor || null;
  const instructors = await withTenant(actor.schoolId, (tx) =>
    many<{ id: string; name: string }>(tx, `SELECT id, first_name || ' ' || last_name AS name FROM instructors WHERE status = 'active' ORDER BY first_name`),
  );
  const board = await loadBoard({
    actor,
    zone: school.timezone,
    t,
    f,
    view: q.view,
    date: q.date,
    instructorId,
    basePath: "/admin/calendar",
    extraQuery: instructorId ? `&instructor=${instructorId}` : "",
    showInstructor: true,
  });
  return (
    <>
      <div className="spread">
        <h1>Calendar</h1>
        <Link className="btn primary" href="/admin/lessons/new">Book lesson</Link>
      </div>
      <form className="row" style={{ marginBottom: 12 }}>
        <input type="hidden" name="view" value={board.view} />
        <input type="hidden" name="date" value={board.focus} />
        <select name="instructor" defaultValue={instructorId ?? ""} aria-label="Instructor" style={{ width: "auto" }}>
          <option value="">All instructors</option>
          {instructors.map((i) => <option key={i.id} value={i.id}>{i.name}</option>)}
        </select>
        <button>Filter</button>
      </form>
      <ScheduleBoard {...board} />
    </>
  );
}
