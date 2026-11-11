import Link from "next/link";
import { many, withTenant } from "@/lib/db";
import { StatusBadge, sp, type SearchParams } from "@/components/ui";
import { can } from "@/lib/rbac";
import { requireInstructorProfile } from "../data";
import { unplannedStudents } from "@/server/services/attention";

export default async function MyStudents({ searchParams }: { searchParams: SearchParams }) {
  const q = await sp(searchParams);
  const { actor, t, f, locale } = await requireInstructorProfile();
  const search = q.q ?? "";
  const onlyUnplanned = q.show === "unplanned";
  const unplanned = await withTenant(actor.schoolId, (tx) => unplannedStudents(tx, actor.instructorId!, 200));
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
  const unplannedIds = new Set(unplanned.map((u) => u.id));
  return (
    <>
      <div className="spread" style={{ marginBottom: 8 }}>
        <h1 style={{ margin: 0 }}>{t("instructor.studentsTitle")}</h1>
        <span className="row" style={{ gap: 8 }}>
          {can(actor.role, "students:write") && <Link className="btn primary sm" href="/instructor/students/new">+ {t("instructor.addStudent.title")}</Link>}
          <Link className="btn sm" href="/instructor/lessons/new">+ {t("instructor.plan.title")}</Link>
        </span>
      </div>
      <nav className="chips" aria-label={t("instructor.attention.chip")} style={{ marginBottom: 10 }}>
        <Link className={`chip${onlyUnplanned ? "" : " on"}`} href="/instructor/students" aria-current={onlyUnplanned ? undefined : "page"}>{t("instructor.attention.all")}</Link>
        <Link className={`chip${onlyUnplanned ? " on" : ""}`} href="/instructor/students?show=unplanned" aria-current={onlyUnplanned ? "page" : undefined} data-testid="filter-unplanned">
          {t("instructor.attention.unplanned", { count: unplanned.length })}
        </Link>
      </nav>
      {onlyUnplanned ? (
        <section className="card" data-testid="unplanned-list">
          {unplanned.length === 0 && <p className="muted">{t("instructor.attention.empty")}</p>}
          {unplanned.map((s) => (
            <div key={s.id} className="list-row">
              <span className="avatar" aria-hidden="true">{s.name.trim()[0]}</span>
              <Link href={`/students/${s.id}`} style={{ flex: 1, minWidth: 0, color: "inherit", textDecoration: "none" }}>
                <strong>{s.name}</strong>
                <span className="sub" style={{ display: "block" }}>
                  {s.last_lesson ? t("instructor.attention.since", { date: f.shortDate(s.last_lesson) }) : t("instructor.attention.never")}
                  {s.credit > 0 && <> · {t("instructor.attention.credit", { count: s.credit })}</>}
                </span>
              </Link>
              <Link className="btn primary sm" href={`/instructor/lessons/new?student=${s.id}`}>{t("instructor.attention.plan")}</Link>
            </div>
          ))}
        </section>
      ) : (<>
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
              {!s.next_lesson && unplannedIds.has(s.id) && <><br /><span className="attention-chip">{t("instructor.attention.chip")}</span></>}
            </span>
          </Link>
        ))}
      </section>
      </>)}
    </>
  );
}
