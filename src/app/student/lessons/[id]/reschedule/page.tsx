import Link from "next/link";
import { DateTime } from "luxon";
import { one, withTenant } from "@/lib/db";
import { Flash, sp, type SearchParams } from "@/components/ui";
import { tryTranslate } from "@/i18n";
import { getI18n } from "@/i18n/server";
import { requireSchoolActor, requireSchoolPage } from "@/server/auth/session";
import { userPrincipal } from "@/server/principal";
import { checkStudentReschedule } from "@/server/policies";
import { dbNow, loadSchoolContext, searchSlots } from "@/server/scheduling/loader";
import { rescheduleLesson } from "@/server/services/lessons";
import { schoolI18n } from "@/server/school";
import { runAction, str } from "@/server/web";

async function rescheduleAction(fd: FormData) {
  "use server";
  const lessonId = str(fd, "lessonId");
  const { t } = await getI18n();
  let pending = false;
  await runAction(
    async () => {
      const actor = await requireSchoolActor("lessons:request_reschedule");
      const [start, end, instructorId, vehicleId] = str(fd, "slot").split("|");
      if (!start || !end || !instructorId) throw new Error(t("errors.pickTime"));
      const r = await withTenant(actor.schoolId, (tx) =>
        rescheduleLesson(tx, userPrincipal(actor), lessonId, { start: new Date(start), end: new Date(end), instructorId, vehicleId: vehicleId || null }, { channel: "student_portal", reason: str(fd, "reason") || undefined }),
      );
      pending = r.status === "pending_approval";
    },
    { back: `/student/lessons/${lessonId}/reschedule`, success: "/student", okMessage: () => (pending ? t("student.rescheduleRequestedOk") : t("student.rescheduledOk")) },
  );
}

export default async function ReschedulePage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: SearchParams }) {
  const { id } = await params;
  const q = await sp(searchParams);
  const actor = await requireSchoolPage("lessons:request_reschedule");
  const { t, f, locale, school } = await schoolI18n(actor.schoolId);

  const data = await withTenant(actor.schoolId, async (tx) => {
    const lesson = await one<{ id: string; student_id: string; start_time: Date; end_time: Date; status: string; lesson_number: number }>(
      tx,
      `SELECT id, student_id, start_time, end_time, status, lesson_number FROM lessons WHERE id = $1`,
      [id],
    );
    if (!lesson || lesson.student_id !== actor.studentId) return null;
    const ctx = await loadSchoolContext(tx, actor.schoolId);
    // The same rule is enforced again by rescheduleLesson when the form is submitted.
    const policy = checkStudentReschedule({ lessonStart: lesson.start_time, status: lesson.status as "scheduled", now: await dbNow(tx), noticeHours: ctx.settings.min_reschedule_notice_hours, timezone: ctx.timezone });
    const slots = policy.allowed
      ? await searchSlots(tx, ctx, { studentId: lesson.student_id, durationMinutes: Math.round((lesson.end_time.getTime() - lesson.start_time.getTime()) / 60000), ignoreLessonIds: [lesson.id], distinctTimes: true, maxSlots: 40 })
      : [];
    return { lesson, policy, slots, hours: ctx.settings.min_reschedule_notice_hours };
  });
  if (!data) return <p>{t("common.notFound")}</p>;
  const { lesson, policy, slots } = data;
  const byDay = new Map<string, typeof slots>();
  for (const s of slots) {
    const key = DateTime.fromJSDate(s.start, { zone: school.timezone }).toISODate()!;
    byDay.set(key, [...(byDay.get(key) ?? []), s]);
  }

  return (
    <>
      <p><Link href="/student"><span className="flip" style={{ display: "inline-block" }}>←</span> {t("common.back")}</Link></p>
      <h1>{t("student.rescheduleTitle", { number: lesson.lesson_number })}</h1>
      <Flash searchParams={q} />
      <div className="card">
        <p className="muted small">{t("student.currentLesson")}</p>
        <p><strong>{f.date(lesson.start_time)}</strong><br /><span className="num">{f.range(lesson.start_time, lesson.end_time)}</span></p>
      </div>
      {!policy.allowed ? (
        <div className="flash error">{tryTranslate(locale, `errors.${policy.code}`, { hours: data.hours }) ?? policy.message}</div>
      ) : slots.length === 0 ? (
        <div className="card"><p>{t("student.noSlots")}</p></div>
      ) : (
        <form action={rescheduleAction} className="card">
          <input type="hidden" name="lessonId" value={lesson.id} />
          <h2>{t("student.available")}</h2>
          {[...byDay.entries()].map(([day, list]) => (
            <fieldset key={day} style={{ border: 0, padding: 0, margin: "0 0 12px" }}>
              <legend style={{ fontWeight: 700, marginBottom: 6 }}>{f.date(list[0]!.start)}</legend>
              <div className="slot-list" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(140px, 1fr))" }}>
                {list.map((s) => {
                  const value = [s.start.toISOString(), s.end.toISOString(), s.instructorId, s.vehicleId ?? ""].join("|");
                  return (
                    <label key={value} className="slot-option">
                      <input type="radio" name="slot" value={value} required />
                      <span className="num">{f.range(s.start, s.end)}</span>
                    </label>
                  );
                })}
              </div>
            </fieldset>
          ))}
          <div className="field">
            <label htmlFor="reason">{t("common.reason")} <span className="muted small">({t("common.optional")})</span></label>
            <input id="reason" name="reason" maxLength={300} />
          </div>
          <button className="primary block" type="submit">{t("student.confirmNewTime")}</button>
        </form>
      )}
    </>
  );
}
