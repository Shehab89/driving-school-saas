import Link from "next/link";
import { DateTime } from "luxon";
import { many, one, withTenant } from "@/lib/db";
import { can } from "@/lib/rbac";
import { schoolI18n } from "@/server/school";
import { Flash, sp, type SearchParams } from "@/components/ui";
import { requireSchoolPage } from "@/server/auth/session";
import { loadSchoolContext, searchSlots } from "@/server/scheduling/loader";
import { staffRescheduleAction } from "../actions";

export default async function StaffReschedulePage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: SearchParams }) {
  const { id } = await params;
  const q = await sp(searchParams);
  const actor = await requireSchoolPage("lessons:operate_own");
  const staff = can(actor.role, "lessons:write_all");
  const { t, f } = await schoolI18n(actor.schoolId);

  const d = await withTenant(actor.schoolId, async (tx) => {
    const lesson = await one<{ id: string; student_id: string; instructor_id: string; start_time: Date; end_time: Date; lesson_number: number }>(
      tx,
      `SELECT id, student_id, instructor_id, start_time, end_time, lesson_number FROM lessons WHERE id = $1`,
      [id],
    );
    if (!lesson || (!staff && lesson.instructor_id !== actor.instructorId)) return null;
    const ctx = await loadSchoolContext(tx, actor.schoolId);
    const from = q.from ? DateTime.fromISO(q.from, { zone: ctx.timezone }).toJSDate() : new Date();
    const slots = await searchSlots(tx, ctx, {
      studentId: lesson.student_id,
      from,
      to: DateTime.fromJSDate(from).plus({ days: 14 }).toJSDate(),
      durationMinutes: Math.round((lesson.end_time.getTime() - lesson.start_time.getTime()) / 60000),
      ignoreLessonIds: [lesson.id],
      // Instructors move their own lessons; staff may move to any instructor.
      instructorIds: staff ? undefined : [lesson.instructor_id],
      ignoreStudentPreferences: true,
      ignoreLeadTime: true,
      maxSlots: 120,
    });
    const names = await many<{ id: string; first_name: string }>(tx, `SELECT id, first_name FROM instructors`);
    return { lesson, slots, tz: ctx.timezone, names: new Map(names.map((n) => [n.id, n.first_name])) };
  });
  if (!d) return <p>{t("common.notFound")}</p>;

  const byDay = new Map<string, typeof d.slots>();
  for (const s of d.slots) {
    const key = DateTime.fromJSDate(s.start, { zone: d.tz }).toISODate()!;
    byDay.set(key, [...(byDay.get(key) ?? []), s]);
  }
  return (
    <div className="narrow">
      <p><Link href={`/lessons/${id}`}><span className="flip" style={{ display: "inline-block" }}>←</span> {t("common.back")}</Link></p>
      <h1>{t("instructor.lesson.moveTitle", { number: d.lesson.lesson_number })}</h1>
      <p className="muted">{t("instructor.lesson.now", { when: `${f.date(d.lesson.start_time)} ${f.range(d.lesson.start_time, d.lesson.end_time)}` })}</p>
      <Flash searchParams={q} />
      <form className="row" style={{ marginBottom: 12 }}>
        <label htmlFor="from" style={{ margin: 0 }}>{t("student.from")}</label>
        <input id="from" type="date" name="from" defaultValue={q.from} style={{ width: 170 }} />
        <button>{t("common.search")}</button>
      </form>
      <form action={staffRescheduleAction} className="card">
        <input type="hidden" name="lessonId" value={id} />
        {[...byDay.entries()].map(([day, list]) => (
          <fieldset key={day} style={{ border: 0, padding: 0, margin: "0 0 12px" }}>
            <legend style={{ fontWeight: 700 }}>{f.date(list[0]!.start)}</legend>
            <div className="slot-list">
              {list.map((s) => {
                const v = [s.start.toISOString(), s.end.toISOString(), s.instructorId, s.vehicleId ?? ""].join("|");
                return (
                  <label key={v} className="slot-option">
                    <input type="radio" name="slot" value={v} required />
                    <span className="num">{f.range(s.start, s.end)}{staff && ` · ${d.names.get(s.instructorId)}`}</span>
                  </label>
                );
              })}
            </div>
          </fieldset>
        ))}
        {d.slots.length === 0 && <p className="muted">{t("instructor.lesson.noFreeSlots")}</p>}
        <div className="field"><label htmlFor="reason">{t("common.reason")}</label><input id="reason" name="reason" /></div>
        <button className="primary block" disabled={d.slots.length === 0}>{t("instructor.lesson.moveLesson")}</button>
      </form>
    </div>
  );
}
