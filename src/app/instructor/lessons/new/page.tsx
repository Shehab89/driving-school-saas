import { DateTime } from "luxon";
import { after } from "next/server";
import { many, one, withTenant } from "@/lib/db";
import { ValidationError } from "@/lib/errors";
import { Flash, sp, type SearchParams } from "@/components/ui";
import { DateField } from "@/components/date-field";
import { dateFieldLabels } from "@/components/date-field-labels";
import { getI18n } from "@/i18n/server";
import { requireSchoolActor } from "@/server/auth/session";
import { deliverNotifications } from "@/server/jobs";
import { userPrincipal } from "@/server/principal";
import { schoolHeader } from "@/server/school";
import { bookLesson } from "@/server/services/lessons";
import { num, runAction, str } from "@/server/web";
import { requireInstructorProfile } from "../../data";

async function planAction(fd: FormData) {
  "use server";
  const { t } = await getI18n();
  const studentId = str(fd, "studentId");
  await runAction(
    async () => {
      const actor = await requireSchoolActor("lessons:operate_own");
      if (!actor.instructorId) throw new ValidationError(t("instructor.plan.noProfile"));
      const tz = (await schoolHeader(actor.schoolId)).timezone;
      const start = DateTime.fromISO(`${str(fd, "date")}T${str(fd, "time")}`, { zone: tz });
      if (!start.isValid || start < DateTime.now()) throw new ValidationError(t("instructor.plan.future"));
      const minutes = Math.min(240, Math.max(15, num(fd, "minutes") ?? 60));
      await withTenant(actor.schoolId, async (tx) => {
        const car = await one<{ default_vehicle_id: string | null }>(tx, `SELECT default_vehicle_id FROM instructors WHERE id = $1`, [actor.instructorId]);
        await bookLesson(tx, userPrincipal(actor), {
          studentId,
          slot: { start: start.toJSDate(), end: start.plus({ minutes }).toJSDate(), instructorId: actor.instructorId!, vehicleId: car?.default_vehicle_id ?? null },
          bookedVia: "staff",
          // Office rights (e.g. a one-person school's owner) may plan outside working hours; overlaps are always refused.
          overrideAvailability: true,
          pickupAddress: str(fd, "pickup"),
          dropoffAddress: str(fd, "dropoff"),
        });
      });
      after(() => deliverNotifications(10).catch(() => undefined));
    },
    { back: `/instructor/lessons/new?student=${studentId}`, success: "/instructor", okMessage: t("instructor.plan.booked") },
  );
}

/** Plan a lesson from the phone: the instructor's own calendar, with meeting and end point. */
export default async function PlanLessonPage({ searchParams }: { searchParams: SearchParams }) {
  const q = await sp(searchParams);
  const { actor, t, locale, school } = await requireInstructorProfile();
  const students = await withTenant(actor.schoolId, (tx) =>
    many<{ id: string; name: string; pickup_address: string | null }>(
      tx,
      `SELECT s.id, s.first_name || ' ' || s.last_name AS name, s.pickup_address FROM students s
        WHERE s.status IN ('active','lead')
          AND (s.primary_instructor_id = $1 OR EXISTS (SELECT 1 FROM lessons l WHERE l.student_id = s.id AND l.instructor_id = $1))
        ORDER BY s.first_name`,
      [actor.instructorId],
    ),
  );
  const today = DateTime.now().setZone(school.timezone);
  const times = Array.from({ length: 57 }, (_, i) => 7 * 60 + i * 15).map((m) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`);
  const chosen = students.find((s) => s.id === q.student);
  return (
    <>
      <h1>{t("instructor.plan.title")}</h1>
      <Flash searchParams={q} />
      {students.length === 0 ? (
        <section className="card"><p className="muted">{t("instructor.studentsEmpty")}</p></section>
      ) : (
        <form action={planAction} className="card">
          <div className="field">
            <label htmlFor="studentId">{t("common.student")}</label>
            <select id="studentId" name="studentId" defaultValue={chosen?.id ?? ""} required>
              <option value="" disabled>—</option>
              {students.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          </div>
          <div className="field"><label htmlFor="date">{t("common.date")}</label><DateField id="date" name="date" defaultValue={today.plus({ days: 1 }).toISODate()!} min={today.toISODate()!} locale={locale} labels={dateFieldLabels(t)} required /></div>
          <div className="row" style={{ gap: 12 }}>
            <div className="field" style={{ flex: 1 }}><label htmlFor="time">{t("common.time")}</label><select id="time" name="time" defaultValue="10:00">{times.map((x) => <option key={x}>{x}</option>)}</select></div>
            <div className="field" style={{ flex: 1 }}><label htmlFor="minutes">{t("instructor.plan.minutes")}</label><select id="minutes" name="minutes" defaultValue="60">{[30, 45, 60, 75, 90, 120].map((m) => <option key={m} value={m}>{m} {t("common.min")}</option>)}</select></div>
          </div>
          <div className="field">
            <label htmlFor="pickup">{t("student.places.meetAt")}</label>
            <input id="pickup" name="pickup" maxLength={200} placeholder={chosen?.pickup_address ?? t("student.places.placeholder")} />
          </div>
          <div className="field">
            <label htmlFor="dropoff">{t("student.places.endsAt")}</label>
            <input id="dropoff" name="dropoff" maxLength={200} placeholder={t("instructor.plan.sameAsStart")} />
          </div>
          <p className="muted small">{t("instructor.plan.placeHint")}</p>
          <button className="primary block" type="submit">{t("instructor.plan.submit")}</button>
        </form>
      )}
    </>
  );
}
