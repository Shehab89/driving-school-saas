import { many, withTenant } from "@/lib/db";
import { ScheduleBoard } from "@/components/schedule-board";
import { loadBoard } from "@/server/schedule";
import { Flash, sp, type SearchParams } from "@/components/ui";
import { requireSchoolPage } from "@/server/auth/session";
import { schoolI18n } from "@/server/school";
import Link from "next/link";

export default async function SchoolCalendar({ searchParams }: { searchParams: SearchParams }) {
  const q = await sp(searchParams);
  const actor = await requireSchoolPage("lessons:read_all");
  const { school, t, f, pt } = await schoolI18n(actor.schoolId);
  const uuid = /^[0-9a-f-]{36}$/i;
  const instructorId = q.instructor && uuid.test(q.instructor) ? q.instructor : null;
  const studentId = q.student && uuid.test(q.student) ? q.student : null;
  const [instructors, students] = await withTenant(actor.schoolId, async (tx) => [
    await many<{ id: string; name: string }>(tx, `SELECT id, first_name || ' ' || last_name AS name FROM instructors WHERE status = 'active' ORDER BY first_name`),
    await many<{ id: string; name: string }>(tx, `SELECT id, first_name || ' ' || last_name AS name FROM students WHERE status = 'active' ORDER BY first_name, last_name`),
  ]);
  const board = await loadBoard({
    actor,
    zone: school.timezone,
    t,
    f,
    view: q.view,
    date: q.date,
    instructorId,
    studentId,
    basePath: "/admin/calendar",
    extraQuery: `${instructorId ? `&instructor=${instructorId}` : ""}${studentId ? `&student=${studentId}` : ""}`,
    showInstructor: true,
  });
  return (
    <>
      <div className="page-title">
        <div>
          <h1>{pt("Calendar")}</h1>
          <p>{pt("Tap a lesson to see details, call the student or move it.")}</p>
        </div>
        <div className="actions"><Link className="btn primary" href="/admin/lessons/new">{pt("Plan a lesson")}</Link></div>
      </div>
      <Flash searchParams={q} />
      <form className="row" style={{ marginBottom: 12 }}>
        <input type="hidden" name="view" value={board.view} />
        <input type="hidden" name="date" value={board.focus} />
        <select name="instructor" defaultValue={instructorId ?? ""} aria-label={pt("Instructor")} style={{ width: "auto" }}>
          <option value="">{pt("All instructors")}</option>
          {instructors.map((i) => <option key={i.id} value={i.id}>{i.name}</option>)}
        </select>
        <select name="student" defaultValue={studentId ?? ""} aria-label={pt("Student")} style={{ width: "auto" }}>
          <option value="">{pt("All students")}</option>
          {students.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select>
        <button className="sm">{pt("Show")}</button>
      </form>
      <ScheduleBoard {...board} />
    </>
  );
}
