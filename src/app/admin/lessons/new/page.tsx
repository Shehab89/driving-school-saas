import Link from "next/link";
import { DateTime } from "luxon";
import { many, one, withTenant } from "@/lib/db";
import { Flash, sp, type SearchParams } from "@/components/ui";
import { requireSchoolActor, requireSchoolPage } from "@/server/auth/session";
import { userPrincipal } from "@/server/principal";
import { loadSchoolContext, searchSlots } from "@/server/scheduling/loader";
import { bookLesson } from "@/server/services/lessons";
import { schoolHeader } from "@/server/school";
import { bool, num, runAction, str } from "@/server/web";
import { after } from "next/server";
import { deliverNotifications } from "@/server/jobs";
import { getPt } from "@/i18n/server";
import { schoolI18n } from "@/server/school";
import { ValidationError } from "@/lib/errors";
import { TopicPicker } from "@/components/topic-picker";
import { listTopics } from "@/server/services/topics";

async function book(fd: FormData) {
  "use server";
  const pt = await getPt();
  const studentId = str(fd, "studentId");
  await runAction(async () => {
    const actor = await requireSchoolActor("lessons:write_all");
    const tz = (await schoolHeader(actor.schoolId)).timezone;
    let slot;
    if (bool(fd, "manual")) {
      // Manual time: staff override of availability; DB constraints still prevent double booking.
      const start = DateTime.fromISO(str(fd, "manualStart"), { zone: tz });
      if (!start.isValid) throw new ValidationError(pt("Pick a start time"));
      slot = { start: start.toJSDate(), end: start.plus({ minutes: num(fd, "minutes") ?? 60 }).toJSDate(), instructorId: str(fd, "instructorId"), vehicleId: str(fd, "vehicleId") || null };
    } else {
      const [s, e, i, v] = str(fd, "slot").split("|");
      if (!s || !e || !i) throw new ValidationError(pt("Pick a time first"));
      slot = { start: new Date(s), end: new Date(e), instructorId: i, vehicleId: v || null };
    }
    const priceEuros = num(fd, "price");
    await withTenant(actor.schoolId, (tx) =>
      bookLesson(tx, userPrincipal(actor), {
        studentId,
        slot,
        bookedVia: "staff",
        overrideAvailability: bool(fd, "manual"),
        priceCents: priceEuros !== undefined ? Math.round(priceEuros * 100) : undefined,
        lessonType: (str(fd, "lessonType") || "practical") as "practical",
        plannedTopicIds: fd.getAll("plannedTopics").map(String),
      }),
    );
    after(() => deliverNotifications(10).catch(() => undefined));
  }, { back: `/admin/lessons/new?student=${studentId}`, success: `/students/${studentId}`, okMessage: pt("Lesson booked. The student gets a confirmation e-mail.") });
}

export default async function NewLessonPage({ searchParams }: { searchParams: SearchParams }) {
  const q = await sp(searchParams);
  const actor = await requireSchoolPage("lessons:write_all");
  const { f, pt, locale } = await schoolI18n(actor.schoolId);
  const kind = ["practical", "exam_prep", "exam", "assessment"].includes(q.type ?? "") ? q.type! : "practical";
  const studentParam = /^[0-9a-f-]{36}$/i.test(q.student ?? "") ? q.student! : null;
  const d = await withTenant(actor.schoolId, async (tx) => {
    const ctx = await loadSchoolContext(tx, actor.schoolId);
    const students = await many<{ id: string; name: string }>(tx, `SELECT id, first_name || ' ' || last_name || ' (' || student_number || ')' AS name FROM students WHERE status IN ('active','lead') ORDER BY first_name`);
    const instructors = await many<{ id: string; name: string }>(tx, `SELECT id, first_name || ' ' || last_name AS name FROM instructors WHERE status = 'active'`);
    const vehicles = await many<{ id: string; label: string }>(tx, `SELECT id, brand || ' ' || model || ' ' || transmission AS label FROM vehicles WHERE status = 'active'`);
    const student = studentParam ? await one<{ id: string; first_name: string }>(tx, `SELECT id, first_name FROM students WHERE id = $1`, [studentParam]) : null;
    const fromParam = q.from ? DateTime.fromISO(q.from, { zone: ctx.timezone }) : null;
    const from = fromParam?.isValid ? fromParam : DateTime.now().setZone(ctx.timezone);
    const minutes = Math.min(480, Math.max(15, Number(q.minutes) || ctx.settings.default_lesson_minutes));
    const slots = student
      ? await searchSlots(tx, ctx, { studentId: student.id, from: from.toJSDate(), to: from.plus({ days: 14 }).toJSDate(), durationMinutes: minutes, ignoreLeadTime: true, maxSlots: 150 })
      : [];
    const topics = await listTopics(tx, locale);
    return { ctx, students, instructors, vehicles, student, slots, minutes, topics, names: new Map(instructors.map((i) => [i.id, i.name])) };
  });
  const tz = d.ctx.timezone;
  const byDay = new Map<string, typeof d.slots>();
  for (const s of d.slots) {
    const k = DateTime.fromJSDate(s.start, { zone: tz }).toISODate()!;
    byDay.set(k, [...(byDay.get(k) ?? []), s]);
  }
  return (
    <div className="narrow" style={{ maxWidth: 760 }}>
      <p><Link href="/admin/calendar"><span className="flip">←</span> {pt("Calendar")}</Link></p>
      <div className="page-title"><div><h1>{pt("Plan a lesson")}</h1><p>{pt("Choose the student, then tap a free time.")}</p></div></div>
      <Flash searchParams={q} />
      <form className="card">
        <h2><span className="step">1</span> {pt("Student and length")}</h2>
        <div className="field">
          <label htmlFor="student">{pt("Student")}</label>
          <select id="student" name="student" defaultValue={studentParam ?? ""} required>
            <option value="">{pt("Choose…")}</option>
            {d.students.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </div>
        <div className="fields">
          <div className="field"><label htmlFor="from">{pt("Starting from")}</label><input id="from" type="date" name="from" defaultValue={q.from} /></div>
          <div className="field"><label htmlFor="minutes">{pt("Length (minutes)")}</label><input id="minutes" type="number" name="minutes" min={15} step={15} defaultValue={d.minutes} /></div>
        </div>
        {kind !== "practical" && <input type="hidden" name="type" value={kind} />}
        <button className={d.student ? "" : "primary"}>{pt("Show free times")}</button>
      </form>

      {d.student && (
        <form action={book} className="card">
          <input type="hidden" name="studentId" value={d.student.id} />
          <h2><span className="step">2</span> {pt("Free times for {name}", { name: d.student.first_name })}</h2>
          {d.slots.length === 0 && <p className="muted">{pt("No free times in the next 14 days. Check the instructors' working hours, the opening hours and that a matching car is available, or enter a time by hand below.")}</p>}
          {[...byDay.entries()].map(([day, list]) => (
            <fieldset key={day} style={{ border: 0, padding: 0, margin: "0 0 12px" }}>
              <legend style={{ fontWeight: 700, marginBottom: 6 }}>{f.date(list[0]!.start)}</legend>
              <div className="slot-list">
                {list.map((s) => {
                  const v = [s.start.toISOString(), s.end.toISOString(), s.instructorId, s.vehicleId ?? ""].join("|");
                  return (
                    <label key={v} className="slot-option">
                      <input type="radio" name="slot" value={v} />
                      <span><span dir="ltr">{f.range(s.start, s.end)}</span> · {d.names.get(s.instructorId)}</span>
                    </label>
                  );
                })}
              </div>
            </fieldset>
          ))}
          <details style={{ marginBottom: 12 }}>
            <summary>{pt("Or enter a time by hand (ignores working hours)")}</summary>
            <label className="check" style={{ margin: "8px 0" }}><input type="checkbox" name="manual" /> {pt("Use this time")}</label>
            <div className="fields">
              <div className="field"><label htmlFor="manualStart">{pt("Start")}</label><input id="manualStart" type="datetime-local" name="manualStart" /></div>
              <div className="field"><label htmlFor="mm">{pt("Length (minutes)")}</label><input id="mm" type="number" name="minutes" defaultValue={d.minutes} /></div>
              <div className="field"><label htmlFor="instructorId">{pt("Instructor")}</label><select id="instructorId" name="instructorId">{d.instructors.map((i) => <option key={i.id} value={i.id}>{i.name}</option>)}</select></div>
              <div className="field"><label htmlFor="vehicleId">{pt("Car")}</label><select id="vehicleId" name="vehicleId"><option value="">{pt("None")}</option>{d.vehicles.map((v) => <option key={v.id} value={v.id}>{v.label}</option>)}</select></div>
            </div>
          </details>
          <div className="fields">
            <div className="field"><label htmlFor="lessonType">{pt("Kind of lesson")}</label><select id="lessonType" name="lessonType" defaultValue={kind}><option value="practical">{pt("Driving lesson")}</option><option value="exam_prep">{pt("Exam preparation")}</option><option value="exam">{pt("Exam")}</option><option value="assessment">{pt("Intake / assessment")}</option></select></div>
            <div className="field"><label htmlFor="price">{pt("Price ({currency}), leave empty for the normal price", { currency: d.ctx.currency })}</label><input id="price" type="number" step="0.01" min="0" name="price" /></div>
          </div>
          <div className="field">
            <label htmlFor="tp-plannedTopics">{pt("Lesson topics")}</label>
            <TopicPicker name="plannedTopics" topics={d.topics} label={pt("Lesson topics")} placeholder={pt("Choose one or more topics")} />
          </div>
          <button className="primary block">{kind === "exam" ? pt("Book exam") : pt("Book lesson")}</button>
        </form>
      )}
    </div>
  );
}
