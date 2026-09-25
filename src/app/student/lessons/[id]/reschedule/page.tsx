import Link from "next/link";
import { DateTime } from "luxon";
import { one, withTenant } from "@/lib/db";
import { formatDate, formatTimeRange } from "@/lib/time";
import { Flash, sp, type SearchParams } from "@/components/ui";
import { requireSchoolActor, requireSchoolPage } from "@/server/auth/session";
import { userPrincipal } from "@/server/principal";
import { checkStudentReschedule } from "@/server/policies";
import { dbNow, loadSchoolContext, searchSlots } from "@/server/scheduling/loader";
import { rescheduleLesson } from "@/server/services/lessons";
import { runAction, str } from "@/server/web";

async function rescheduleAction(fd: FormData) {
  "use server";
  const lessonId = str(fd, "lessonId");
  const back = `/student/lessons/${lessonId}/reschedule`;
  await runAction(
    async () => {
      const actor = await requireSchoolActor("lessons:request_reschedule");
      const [start, end, instructorId, vehicleId] = str(fd, "slot").split("|");
      if (!start || !end || !instructorId) throw new Error("Please choose a time");
      await withTenant(actor.schoolId, (tx) =>
        rescheduleLesson(
          tx,
          userPrincipal(actor),
          lessonId,
          { start: new Date(start), end: new Date(end), instructorId, vehicleId: vehicleId || null },
          { channel: "student_portal", reason: str(fd, "reason") || undefined },
        ),
      );
    },
    { back, success: "/student", okMessage: "Your lesson has been moved. A confirmation e-mail is on its way." },
  );
}

export default async function ReschedulePage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: SearchParams }) {
  const { id } = await params;
  const q = await sp(searchParams);
  const actor = await requireSchoolPage("lessons:request_reschedule");

  const data = await withTenant(actor.schoolId, async (tx) => {
    const lesson = await one<{ id: string; student_id: string; start_time: Date; end_time: Date; status: string; lesson_number: number }>(
      tx,
      `SELECT id, student_id, start_time, end_time, status, lesson_number FROM lessons WHERE id = $1`,
      [id],
    );
    if (!lesson || lesson.student_id !== actor.studentId) return null;
    const ctx = await loadSchoolContext(tx, actor.schoolId);
    const now = await dbNow(tx);
    // Same rule as the backend enforces on submit.
    const policy = checkStudentReschedule({ lessonStart: lesson.start_time, status: lesson.status as "scheduled", now, noticeHours: ctx.settings.min_reschedule_notice_hours, timezone: ctx.timezone });
    const slots = policy.allowed
      ? await searchSlots(tx, ctx, {
          studentId: lesson.student_id,
          durationMinutes: Math.round((lesson.end_time.getTime() - lesson.start_time.getTime()) / 60000),
          ignoreLessonIds: [lesson.id],
          distinctTimes: true,
          maxSlots: 40,
        })
      : [];
    return { lesson, policy, slots, tz: ctx.timezone };
  });
  if (!data) return <p>Lesson not found.</p>;
  const { lesson, policy, slots, tz } = data;

  // Group by day for a compact mobile list.
  const byDay = new Map<string, typeof slots>();
  for (const s of slots) {
    const key = DateTime.fromJSDate(s.start, { zone: tz }).toISODate()!;
    byDay.set(key, [...(byDay.get(key) ?? []), s]);
  }

  return (
    <div className="narrow">
      <p><Link href="/student">← Back</Link></p>
      <h1>Reschedule lesson #{lesson.lesson_number}</h1>
      <Flash searchParams={q} />
      <div className="card">
        <p className="muted small">Current lesson</p>
        <p><strong>{formatDate(lesson.start_time, tz)}</strong><br />{formatTimeRange(lesson.start_time, lesson.end_time, tz)}</p>
      </div>
      {!policy.allowed ? (
        <div className="flash error">{policy.message}</div>
      ) : slots.length === 0 ? (
        <div className="card"><p>No free times in the coming weeks. Please contact the school.</p></div>
      ) : (
        <form action={rescheduleAction} className="card">
          <input type="hidden" name="lessonId" value={lesson.id} />
          <h2>Available</h2>
          {[...byDay.entries()].map(([day, list]) => (
            <fieldset key={day} style={{ border: 0, padding: 0, margin: "0 0 12px" }}>
              <legend style={{ fontWeight: 700, marginBottom: 6 }}>{formatDate(list[0]!.start, tz)}</legend>
              <div className="slot-list">
                {list.map((s) => {
                  const value = [s.start.toISOString(), s.end.toISOString(), s.instructorId, s.vehicleId ?? ""].join("|");
                  return (
                    <label key={value} className="slot-option">
                      <input type="radio" name="slot" value={value} required />
                      <span>{formatTimeRange(s.start, s.end, tz)}</span>
                    </label>
                  );
                })}
              </div>
            </fieldset>
          ))}
          <div className="field">
            <label htmlFor="reason">Reason (optional)</label>
            <input id="reason" name="reason" maxLength={300} />
          </div>
          <button className="primary block" type="submit">Confirm new time</button>
        </form>
      )}
    </div>
  );
}
