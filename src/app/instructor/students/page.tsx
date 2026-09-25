import Link from "next/link";
import { many, withTenant } from "@/lib/db";
import { StatusBadge, sp, type SearchParams } from "@/components/ui";
import { requireInstructorProfile } from "../data";

export default async function MyStudents({ searchParams }: { searchParams: SearchParams }) {
  const q = await sp(searchParams);
  const { actor, t, f, locale } = await requireInstructorProfile();
  const search = q.q ?? "";
  // Only students this instructor teaches (primary instructor, or has had / has a lesson with them).
  const students = await withTenant(actor.schoolId, (tx) =>
    many<{ id: string; name: string; phone: string | null; status: string; level_position: number | null; level_name: string | null; done: number; last_lesson: Date | null; next_lesson: Date | null }>(
      tx,
      `SELECT s.id, s.first_name || ' ' || s.last_name AS name, s.phone, s.status, ld.position AS level_position,
              COALESCE(ld.name_translations->>$3, ld.name) AS level_name,
              (SELECT count(*)::int FROM lessons l WHERE l.student_id = s.id AND l.status = 'completed') AS done,
              (SELECT max(start_time) FROM lessons l WHERE l.student_id = s.id AND l.status = 'completed') AS last_lesson,
              (SELECT min(start_time) FROM lessons l WHERE l.student_id = s.id AND l.status IN ('scheduled','confirmed') AND l.start_time > now()) AS next_lesson
         FROM students s LEFT JOIN level_definitions ld ON ld.id = s.current_level_id
        WHERE s.status <> 'archived'
          AND (s.primary_instructor_id = $1 OR EXISTS (SELECT 1 FROM lessons l WHERE l.student_id = s.id AND l.instructor_id = $1))
          AND ($2 = '' OR s.first_name || ' ' || s.last_name ILIKE '%' || $2 || '%' OR s.phone ILIKE '%' || $2 || '%')
        ORDER BY next_lesson NULLS LAST, s.first_name`,
      [actor.instructorId, search, locale],
    ),
  );
  return (
    <>
      <h1>{t("instructor.studentsTitle")}</h1>
      <form className="row" style={{ marginBottom: 12 }}>
        <input name="q" defaultValue={search} placeholder={t("instructor.searchStudents")} aria-label={t("common.search")} style={{ flex: 1 }} />
        <button>{t("common.search")}</button>
      </form>
      <section className="card">
        {students.length === 0 && <p className="muted">{t("instructor.studentsEmpty")}</p>}
        {students.map((s) => (
          <Link key={s.id} href={`/students/${s.id}`} className="list-row">
            <span className="avatar" aria-hidden="true">{s.name.trim()[0]}</span>
            <span style={{ flex: 1, minWidth: 0 }}>
              <strong>{s.name}</strong> {s.status !== "active" && <StatusBadge value={s.status} t={t} />}
              <span className="sub" style={{ display: "block" }}>
                {s.level_position ? t("common.level", { position: s.level_position }) : t("common.levelNotSet")} · {t("instructor.lessonsDone", { count: s.done })}
              </span>
            </span>
            <span className="sub" style={{ textAlign: "end" }}>
              {s.next_lesson ? <>{t("instructor.nextLesson")}<br /><strong className="num">{f.dateTime(s.next_lesson)}</strong></> : s.last_lesson ? <>{t("instructor.lastLesson")}<br />{f.shortDate(s.last_lesson)}</> : null}
            </span>
          </Link>
        ))}
      </section>
    </>
  );
}
