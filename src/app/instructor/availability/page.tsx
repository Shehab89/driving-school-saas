import { DateTime } from "luxon";
import { many, withTenant } from "@/lib/db";
import { Flash, sp, type SearchParams } from "@/components/ui";
import { requireSchoolActor, requireSchoolPage } from "@/server/auth/session";
import { userPrincipal } from "@/server/principal";
import { schoolHeader } from "@/server/school";
import { addAvailabilityException, addAvailabilityRule, deleteAvailabilityRule, listInstructorAvailability } from "@/server/services/staff";
import { runAction, str } from "@/server/web";
import { formatDateTime } from "@/lib/time";

const DAYS = ["", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

async function addRule(fd: FormData) {
  "use server";
  await runAction(async () => {
    const actor = await requireSchoolActor();
    const kind = str(fd, "kind");
    await withTenant(actor.schoolId, (tx) =>
      addAvailabilityRule(tx, userPrincipal(actor), {
        instructorId: str(fd, "instructorId"),
        isRecurring: kind === "weekly",
        weekday: kind === "weekly" ? Number(str(fd, "weekday")) : undefined,
        specificDate: kind === "date" ? str(fd, "date") : undefined,
        start: str(fd, "start"),
        end: str(fd, "end"),
      }),
    );
  }, { back: `/instructor/availability?instructor=${str(fd, "instructorId")}` });
}

async function removeRule(fd: FormData) {
  "use server";
  await runAction(async () => {
    const actor = await requireSchoolActor();
    await withTenant(actor.schoolId, (tx) => deleteAvailabilityRule(tx, userPrincipal(actor), str(fd, "ruleId")));
  }, { back: `/instructor/availability?instructor=${str(fd, "instructorId")}`, okMessage: "Removed" });
}

async function addTimeOff(fd: FormData) {
  "use server";
  await runAction(async () => {
    const actor = await requireSchoolActor();
    const tz = (await schoolHeader(actor.schoolId)).timezone;
    const startsAt = DateTime.fromISO(str(fd, "from"), { zone: tz }).toJSDate();
    const endsAt = DateTime.fromISO(str(fd, "until"), { zone: tz }).toJSDate();
    await withTenant(actor.schoolId, (tx) =>
      addAvailabilityException(tx, userPrincipal(actor), { instructorId: str(fd, "instructorId"), kind: str(fd, "exKind") === "available" ? "available" : "unavailable", startsAt, endsAt, reason: str(fd, "reason") }),
    );
  }, { back: `/instructor/availability?instructor=${str(fd, "instructorId")}` });
}

export default async function AvailabilityPage({ searchParams }: { searchParams: SearchParams }) {
  const q = await sp(searchParams);
  const actor = await requireSchoolPage();
  const school = await schoolHeader(actor.schoolId);
  const staff = ["school_owner", "school_admin"].includes(actor.role);
  const instructorId = staff && q.instructor ? q.instructor : actor.instructorId;
  if (!instructorId) return <p>No instructor selected.</p>;
  const data = await withTenant(actor.schoolId, async (tx) => ({
    rules: await listInstructorAvailability(tx, instructorId),
    exceptions: await many<{ id: string; kind: string; starts_at: Date; ends_at: Date; reason: string | null }>(
      tx,
      `SELECT id, kind, starts_at, ends_at, reason FROM instructor_availability_exceptions WHERE instructor_id = $1 AND ends_at > now() ORDER BY starts_at`,
      [instructorId],
    ),
    instructors: staff ? await many<{ id: string; name: string }>(tx, `SELECT id, first_name || ' ' || last_name AS name FROM instructors WHERE status = 'active' ORDER BY first_name`) : [],
  }));

  return (
    <>
      <h1>Availability</h1>
      <Flash searchParams={q} />
      {staff && (
        <form className="row" style={{ marginBottom: 12 }}>
          <select name="instructor" defaultValue={instructorId} aria-label="Instructor">
            {data.instructors.map((i) => <option key={i.id} value={i.id}>{i.name}</option>)}
          </select>
          <button type="submit">Show</button>
        </form>
      )}
      <div className="grid two">
        <section className="card">
          <h2>Working hours</h2>
          {data.rules.length === 0 && <p className="muted">No availability yet: students can&apos;t book lessons with this instructor.</p>}
          <ul>
            {data.rules.map((r) => (
              <li key={r.id} className="spread">
                <span>{r.is_recurring ? `Every ${DAYS[r.weekday!]}` : r.specific_date} · {r.start_time}–{r.end_time}</span>
                <form action={removeRule}>
                  <input type="hidden" name="ruleId" value={r.id} />
                  <input type="hidden" name="instructorId" value={instructorId} />
                  <button className="danger" style={{ minHeight: 30, padding: "2px 8px" }}>Remove</button>
                </form>
              </li>
            ))}
          </ul>
          <form action={addRule} className="stack" style={{ marginTop: 12 }}>
            <input type="hidden" name="instructorId" value={instructorId} />
            <div className="fields">
              <div className="field">
                <label htmlFor="kind">Repeat</label>
                <select id="kind" name="kind"><option value="weekly">Weekly</option><option value="date">One date</option></select>
              </div>
              <div className="field">
                <label htmlFor="weekday">Weekday (weekly)</label>
                <select id="weekday" name="weekday">{DAYS.slice(1).map((d, i) => <option key={d} value={i + 1}>{d}</option>)}</select>
              </div>
              <div className="field"><label htmlFor="date">Date (one date)</label><input id="date" type="date" name="date" /></div>
              <div className="field row">
                <div style={{ flex: 1 }}><label htmlFor="start">From</label><input id="start" type="time" name="start" required /></div>
                <div style={{ flex: 1 }}><label htmlFor="end">Until</label><input id="end" type="time" name="end" required /></div>
              </div>
            </div>
            <button className="primary">Add hours</button>
          </form>
        </section>
        <section className="card">
          <h2>Time off & extra hours</h2>
          <ul>
            {data.exceptions.map((e) => (
              <li key={e.id}>{e.kind === "unavailable" ? "Off" : "Extra"}: {formatDateTime(e.starts_at, school.timezone)} → {formatDateTime(e.ends_at, school.timezone)} {e.reason && <span className="muted">({e.reason})</span>}</li>
            ))}
          </ul>
          <form action={addTimeOff} style={{ marginTop: 12 }}>
            <input type="hidden" name="instructorId" value={instructorId} />
            <div className="fields">
              <div className="field"><label htmlFor="exKind">Type</label><select id="exKind" name="exKind"><option value="unavailable">Time off</option><option value="available">Extra availability</option></select></div>
              <div className="field"><label htmlFor="reason">Reason</label><input id="reason" name="reason" /></div>
              <div className="field"><label htmlFor="from">From</label><input id="from" type="datetime-local" name="from" required /></div>
              <div className="field"><label htmlFor="until">Until</label><input id="until" type="datetime-local" name="until" required /></div>
            </div>
            <button className="primary">Add</button>
          </form>
        </section>
      </div>
    </>
  );
}
