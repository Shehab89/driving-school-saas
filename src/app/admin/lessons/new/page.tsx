import Link from "next/link";
import { DateTime } from "luxon";
import { many, one, withTenant } from "@/lib/db";
import { formatDate, formatTimeRange } from "@/lib/time";
import { Flash, sp, type SearchParams } from "@/components/ui";
import { requireSchoolActor, requireSchoolPage } from "@/server/auth/session";
import { userPrincipal } from "@/server/principal";
import { loadSchoolContext, searchSlots } from "@/server/scheduling/loader";
import { bookLesson } from "@/server/services/lessons";
import { schoolHeader } from "@/server/school";
import { bool, num, runAction, str } from "@/server/web";
import { after } from "next/server";
import { deliverNotifications } from "@/server/jobs";

async function book(fd: FormData) {
  "use server";
  const studentId = str(fd, "studentId");
  await runAction(async () => {
    const actor = await requireSchoolActor("lessons:write_all");
    const tz = (await schoolHeader(actor.schoolId)).timezone;
    let slot;
    if (bool(fd, "manual")) {
      // Manual time: staff override of availability; DB constraints still prevent double booking.
      const start = DateTime.fromISO(str(fd, "manualStart"), { zone: tz });
      if (!start.isValid) throw new Error("Pick a start time");
      slot = { start: start.toJSDate(), end: start.plus({ minutes: num(fd, "minutes") ?? 60 }).toJSDate(), instructorId: str(fd, "instructorId"), vehicleId: str(fd, "vehicleId") || null };
    } else {
      const [s, e, i, v] = str(fd, "slot").split("|");
      if (!s || !e || !i) throw new Error("Pick a time");
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
      }),
    );
    after(() => deliverNotifications(10).catch(() => undefined));
  }, { back: `/admin/lessons/new?student=${studentId}`, success: `/students/${studentId}`, okMessage: "Lesson booked" });
}

export default async function NewLessonPage({ searchParams }: { searchParams: SearchParams }) {
  const q = await sp(searchParams);
  const actor = await requireSchoolPage("lessons:write_all");
  const d = await withTenant(actor.schoolId, async (tx) => {
    const ctx = await loadSchoolContext(tx, actor.schoolId);
    const students = await many<{ id: string; name: string }>(tx, `SELECT id, first_name || ' ' || last_name || ' (' || student_number || ')' AS name FROM students WHERE status IN ('active','lead') ORDER BY first_name`);
    const instructors = await many<{ id: string; name: string }>(tx, `SELECT id, first_name || ' ' || last_name AS name FROM instructors WHERE status = 'active'`);
    const vehicles = await many<{ id: string; label: string }>(tx, `SELECT id, brand || ' ' || model || ' ' || transmission AS label FROM vehicles WHERE status = 'active'`);
    const student = q.student ? await one<{ id: string; first_name: string }>(tx, `SELECT id, first_name FROM students WHERE id = $1`, [q.student]) : null;
    const from = q.from ? DateTime.fromISO(q.from, { zone: ctx.timezone }) : DateTime.now().setZone(ctx.timezone);
    const minutes = Number(q.minutes) || ctx.settings.default_lesson_minutes;
    const slots = student
      ? await searchSlots(tx, ctx, { studentId: student.id, from: from.toJSDate(), to: from.plus({ days: 14 }).toJSDate(), durationMinutes: minutes, ignoreLeadTime: true, maxSlots: 150 })
      : [];
    return { ctx, students, instructors, vehicles, student, slots, minutes, names: new Map(instructors.map((i) => [i.id, i.name])) };
  });
  const tz = d.ctx.timezone;
  const byDay = new Map<string, typeof d.slots>();
  for (const s of d.slots) {
    const k = DateTime.fromJSDate(s.start, { zone: tz }).toISODate()!;
    byDay.set(k, [...(byDay.get(k) ?? []), s]);
  }
  return (
    <div className="narrow">
      <p><Link href="/admin/calendar">← Calendar</Link></p>
      <h1>Book a lesson</h1>
      <Flash searchParams={q} />
      <form className="card">
        <div className="field">
          <label htmlFor="student">Student</label>
          <select id="student" name="student" defaultValue={q.student ?? ""} required>
            <option value="">Choose…</option>
            {d.students.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </div>
        <div className="fields">
          <div className="field"><label htmlFor="from">From date</label><input id="from" type="date" name="from" defaultValue={q.from} /></div>
          <div className="field"><label htmlFor="minutes">Duration (min)</label><input id="minutes" type="number" name="minutes" min={15} step={15} defaultValue={d.minutes} /></div>
        </div>
        <button>Find free times</button>
      </form>

      {d.student && (
        <form action={book} className="card">
          <input type="hidden" name="studentId" value={d.student.id} />
          <h2>Free times for {d.student.first_name}</h2>
          {d.slots.length === 0 && <p className="muted">No free times in the next 14 days (check instructor availability, opening hours and matching vehicles).</p>}
          {[...byDay.entries()].map(([day, list]) => (
            <fieldset key={day} style={{ border: 0, padding: 0, margin: "0 0 12px" }}>
              <legend style={{ fontWeight: 700 }}>{formatDate(list[0]!.start, tz)}</legend>
              <div className="slot-list">
                {list.map((s) => {
                  const v = [s.start.toISOString(), s.end.toISOString(), s.instructorId, s.vehicleId ?? ""].join("|");
                  return (
                    <label key={v} className="slot-option">
                      <input type="radio" name="slot" value={v} />
                      <span>{formatTimeRange(s.start, s.end, tz)} · {d.names.get(s.instructorId)}</span>
                    </label>
                  );
                })}
              </div>
            </fieldset>
          ))}
          <details style={{ marginBottom: 12 }}>
            <summary>Or enter a time manually (overrides availability)</summary>
            <label className="check" style={{ margin: "8px 0" }}><input type="checkbox" name="manual" /> Use manual time</label>
            <div className="fields">
              <div className="field"><label htmlFor="manualStart">Start</label><input id="manualStart" type="datetime-local" name="manualStart" /></div>
              <div className="field"><label htmlFor="mm">Minutes</label><input id="mm" type="number" name="minutes" defaultValue={d.minutes} /></div>
              <div className="field"><label htmlFor="instructorId">Instructor</label><select id="instructorId" name="instructorId">{d.instructors.map((i) => <option key={i.id} value={i.id}>{i.name}</option>)}</select></div>
              <div className="field"><label htmlFor="vehicleId">Vehicle</label><select id="vehicleId" name="vehicleId"><option value="">None</option>{d.vehicles.map((v) => <option key={v.id} value={v.id}>{v.label}</option>)}</select></div>
            </div>
          </details>
          <div className="fields">
            <div className="field"><label htmlFor="lessonType">Type</label><select id="lessonType" name="lessonType"><option value="practical">Practical</option><option value="exam_prep">Exam preparation</option><option value="exam">Exam</option><option value="assessment">Assessment</option></select></div>
            <div className="field"><label htmlFor="price">Price ({d.ctx.currency}, blank = default)</label><input id="price" type="number" step="0.01" min="0" name="price" /></div>
          </div>
          <button className="primary block">Book lesson</button>
        </form>
      )}
    </div>
  );
}
