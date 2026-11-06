import Link from "next/link";
import { notFound } from "next/navigation";
import { DateTime } from "luxon";
import { idOr404 } from "@/server/web";
import { many, one, withTenant } from "@/lib/db";
import { can } from "@/lib/rbac";
import { durationMinutes } from "@/lib/time";
import { schoolI18n } from "@/server/school";
import { Flash, sp, type SearchParams } from "@/components/ui";
import { requireSchoolPage } from "@/server/auth/session";
import { loadSchoolContext } from "@/server/scheduling/loader";
import { DateField } from "@/components/date-field";
import { dateFieldLabels } from "@/components/date-field-labels";
import { TopicPicker } from "@/components/topic-picker";
import { listTopics, topicsForLessons } from "@/server/services/topics";
import { editLessonAction } from "../actions";

/** One screen to change a planned lesson: day, start time, topics (and, for the office, instructor and car). */
export default async function EditLessonPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: SearchParams }) {
  const id = idOr404((await params).id);
  const q = await sp(searchParams);
  const actor = await requireSchoolPage("lessons:operate_own");
  const staff = can(actor.role, "lessons:write_all");
  const { t, f, locale } = await schoolI18n(actor.schoolId);

  const d = await withTenant(actor.schoolId, async (tx) => {
    const lesson = await one<{ id: string; status: string; start_time: Date; end_time: Date; lesson_number: number; instructor_id: string; vehicle_id: string | null; student_name: string }>(
      tx,
      `SELECT l.id, l.status, l.start_time, l.end_time, l.lesson_number, l.instructor_id, l.vehicle_id, s.first_name || ' ' || s.last_name AS student_name
         FROM lessons l JOIN students s ON s.id = l.student_id WHERE l.id = $1`,
      [id],
    );
    if (!lesson || (!staff && lesson.instructor_id !== actor.instructorId)) return null;
    const ctx = await loadSchoolContext(tx, actor.schoolId);
    const instructors = staff ? await many<{ id: string; name: string }>(tx, `SELECT id, first_name || ' ' || last_name AS name FROM instructors WHERE status = 'active' OR id = $1 ORDER BY first_name`, [lesson.instructor_id]) : [];
    const vehicles = staff ? await many<{ id: string; label: string }>(tx, `SELECT id, brand || ' ' || model || ' (' || registration_number || ')' AS label FROM vehicles WHERE status = 'active' OR id = $1 ORDER BY brand, model`, [lesson.vehicle_id]) : [];
    const allTopics = await listTopics(tx, locale);
    const planned = ((await topicsForLessons(tx, [id], locale)).get(id) ?? { planned: [] }).planned.map((x) => x.id);
    return { lesson, tz: ctx.timezone, instructors, vehicles, allTopics, planned };
  });
  if (!d) notFound();
  const l = d.lesson;
  if (!["scheduled", "confirmed"].includes(l.status)) {
    return (
      <div className="narrow">
        <p><Link href={`/lessons/${id}`}><span className="flip" style={{ display: "inline-block" }}>←</span> {t("common.back")}</Link></p>
        <p className="muted">{t("errors.invalid_status")}</p>
      </div>
    );
  }

  const start = DateTime.fromJSDate(l.start_time, { zone: d.tz });
  const cur = start.toFormat("HH:mm");
  const times = new Set<string>([cur]);
  for (let m = 6 * 60; m < 22 * 60; m += 15) times.add(`${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`);
  const today = DateTime.now().setZone(d.tz).toISODate()!;

  return (
    <div className="narrow">
      <p><Link href={`/lessons/${id}`}><span className="flip" style={{ display: "inline-block" }}>←</span> {t("common.back")}</Link></p>
      <h1>{t("instructor.lesson.editTitle", { number: l.lesson_number })}</h1>
      <p className="muted">{l.student_name} · {t("instructor.lesson.now", { when: `${f.date(l.start_time)} ${f.range(l.start_time, l.end_time)}` })}</p>
      <Flash searchParams={q} />
      <form action={editLessonAction} className="card">
        <input type="hidden" name="lessonId" value={id} />
        <div className="fields">
          <div className="field">
            <label htmlFor="date">{t("common.date")}</label>
            <DateField id="date" name="date" defaultValue={start.toISODate()!} min={today} locale={locale} labels={dateFieldLabels(t)} required />
          </div>
          <div className="field">
            <label htmlFor="time">{t("instructor.lesson.startTime")}</label>
            <select id="time" name="time" defaultValue={cur}>
              {[...times].sort().map((x) => <option key={x} value={x}>{x}</option>)}
            </select>
          </div>
        </div>
        <p className="muted small" style={{ marginTop: -4 }}>
          {t("instructor.lesson.lengthKept", { minutes: durationMinutes(l.start_time, l.end_time) })}{" "}
          <Link href={`/lessons/${id}/reschedule`}>{t("instructor.lesson.freeTimes")}</Link>
        </p>
        {staff && (
          <div className="fields">
            <div className="field">
              <label htmlFor="instructorId">{t("common.instructor")}</label>
              <select id="instructorId" name="instructorId" defaultValue={l.instructor_id}>
                {d.instructors.map((i) => <option key={i.id} value={i.id}>{i.name}</option>)}
              </select>
            </div>
            <div className="field">
              <label htmlFor="vehicleId">{t("common.vehicle")}</label>
              <select id="vehicleId" name="vehicleId" defaultValue={l.vehicle_id ?? ""}>
                <option value="">{t("common.noVehicle")}</option>
                {d.vehicles.map((v) => <option key={v.id} value={v.id}>{v.label}</option>)}
              </select>
            </div>
          </div>
        )}
        <div className="field">
          <span className="field-label">{t("topics.planned")}</span>
          <TopicPicker name="topics" topics={d.allTopics} defaultSelected={d.planned} label={t("topics.planned")} placeholder={t("topics.choose")} />
        </div>
        <div className="field">
          <label htmlFor="reason">{t("common.reason")} <span className="muted small">({t("common.optional")})</span></label>
          <input id="reason" name="reason" maxLength={300} />
        </div>
        <p className="muted small">{t("instructor.lesson.changeHint")}</p>
        <button className="primary block">{t("instructor.lesson.saveChanges")}</button>
      </form>
    </div>
  );
}
