import { DateTime } from "luxon";
import { many, withTenant } from "@/lib/db";
import { Flash, sp, type SearchParams } from "@/components/ui";
import { getI18n } from "@/i18n/server";
import { requireSchoolActor } from "@/server/auth/session";
import { userPrincipal } from "@/server/principal";
import { schoolHeader } from "@/server/school";
import { addAvailabilityException, addAvailabilityRule, deleteAvailabilityRule, listInstructorAvailability } from "@/server/services/staff";
import { runAction, str } from "@/server/web";
import { loadInstructor } from "../data";

const back = (fd: FormData) => `/instructor/availability?instructor=${str(fd, "instructorId")}`;

async function addRule(fd: FormData) {
  "use server";
  const { t } = await getI18n();
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
  }, { back: back(fd), okMessage: t("common.saved") });
}

async function removeRule(fd: FormData) {
  "use server";
  const { t } = await getI18n();
  await runAction(async () => {
    const actor = await requireSchoolActor();
    await withTenant(actor.schoolId, (tx) => deleteAvailabilityRule(tx, userPrincipal(actor), str(fd, "ruleId")));
  }, { back: back(fd), okMessage: t("instructor.removed") });
}

async function addTimeOff(fd: FormData) {
  "use server";
  const { t } = await getI18n();
  await runAction(async () => {
    const actor = await requireSchoolActor();
    const tz = (await schoolHeader(actor.schoolId)).timezone;
    await withTenant(actor.schoolId, (tx) =>
      addAvailabilityException(tx, userPrincipal(actor), {
        instructorId: str(fd, "instructorId"),
        kind: str(fd, "exKind") === "available" ? "available" : "unavailable",
        startsAt: DateTime.fromISO(str(fd, "from"), { zone: tz }).toJSDate(),
        endsAt: DateTime.fromISO(str(fd, "until"), { zone: tz }).toJSDate(),
        reason: str(fd, "reason"),
      }),
    );
  }, { back: back(fd), okMessage: t("common.saved") });
}

export default async function AvailabilityPage({ searchParams }: { searchParams: SearchParams }) {
  const q = await sp(searchParams);
  const { actor, t, f } = await loadInstructor();
  const staff = ["school_owner", "school_admin"].includes(actor.role);
  const instructorId = staff && q.instructor ? q.instructor : actor.instructorId;
  if (!instructorId) return <p className="muted">{t("instructor.noProfileText")}</p>;
  const data = await withTenant(actor.schoolId, async (tx) => ({
    rules: await listInstructorAvailability(tx, instructorId),
    exceptions: await many<{ id: string; kind: string; starts_at: Date; ends_at: Date; reason: string | null }>(
      tx,
      `SELECT id, kind, starts_at, ends_at, reason FROM instructor_availability_exceptions WHERE instructor_id = $1 AND ends_at > now() ORDER BY starts_at`,
      [instructorId],
    ),
    instructors: staff ? await many<{ id: string; name: string }>(tx, `SELECT id, first_name || ' ' || last_name AS name FROM instructors WHERE status = 'active' ORDER BY first_name`) : [],
  }));
  const hidden = <input type="hidden" name="instructorId" value={instructorId} />;

  return (
    <>
      <h1>{t("instructor.availabilityTitle")}</h1>
      <Flash searchParams={q} />
      {staff && data.instructors.length > 1 && (
        <form className="row" style={{ marginBottom: 12 }}>
          <select name="instructor" defaultValue={instructorId} aria-label={t("common.instructor")} style={{ flex: 1 }}>
            {data.instructors.map((i) => <option key={i.id} value={i.id}>{i.name}</option>)}
          </select>
          <button type="submit">{t("common.search")}</button>
        </form>
      )}
      <section className="card">
        {data.rules.length === 0 && <p className="muted">{t("instructor.availabilityEmpty")}</p>}
        {data.rules.map((r) => (
          <form key={r.id} action={removeRule} className="list-row">
            <input type="hidden" name="ruleId" value={r.id} />
            {hidden}
            <span>
              {r.is_recurring ? t("instructor.every", { weekday: f.weekday(r.weekday!) }) : f.isoDate(r.specific_date!)} ·{" "}
              <span className="num" dir="ltr">{r.start_time}–{r.end_time}</span>
            </span>
            <button className="danger" style={{ minHeight: 32, padding: "2px 10px" }}>{t("instructor.remove")}</button>
          </form>
        ))}
        <form action={addRule} style={{ marginTop: 12 }}>
          {hidden}
          <div className="fields">
            <div className="field">
              <label htmlFor="kind">{t("instructor.repeat")}</label>
              <select id="kind" name="kind"><option value="weekly">{t("instructor.weekly")}</option><option value="date">{t("instructor.oneDate")}</option></select>
            </div>
            <div className="field">
              <label htmlFor="weekday">{t("instructor.weekday")}</label>
              <select id="weekday" name="weekday">{[1, 2, 3, 4, 5, 6, 7].map((d) => <option key={d} value={d}>{f.weekday(d)}</option>)}</select>
            </div>
            <div className="field"><label htmlFor="date">{t("instructor.dateOnce")}</label><input id="date" type="date" name="date" /></div>
            <div className="field row">
              <div style={{ flex: 1 }}><label htmlFor="start">{t("student.from")}</label><input id="start" type="time" name="start" required /></div>
              <div style={{ flex: 1 }}><label htmlFor="end">{t("student.until")}</label><input id="end" type="time" name="end" required /></div>
            </div>
          </div>
          <button className="primary">{t("instructor.addHours")}</button>
        </form>
      </section>
      <section className="card">
        <h2>{t("instructor.timeOff")}</h2>
        {data.exceptions.map((e) => (
          <p key={e.id} className="small">
            <strong>{e.kind === "unavailable" ? t("instructor.off") : t("instructor.extra")}</strong>: {f.dateTime(e.starts_at)} → {f.dateTime(e.ends_at)}
            {e.reason && <span className="muted"> ({e.reason})</span>}
          </p>
        ))}
        <form action={addTimeOff} style={{ marginTop: 12 }}>
          {hidden}
          <div className="fields">
            <div className="field"><label htmlFor="exKind">{t("instructor.type")}</label><select id="exKind" name="exKind"><option value="unavailable">{t("instructor.timeOffOption")}</option><option value="available">{t("instructor.extraOption")}</option></select></div>
            <div className="field"><label htmlFor="reason">{t("common.reason")}</label><input id="reason" name="reason" /></div>
            <div className="field"><label htmlFor="from">{t("student.from")}</label><input id="from" type="datetime-local" name="from" required /></div>
            <div className="field"><label htmlFor="until">{t("student.until")}</label><input id="until" type="datetime-local" name="until" required /></div>
          </div>
          <button className="primary">{t("instructor.add")}</button>
        </form>
      </section>
    </>
  );
}
