import { z } from "zod";
import { one, withTenant } from "@/lib/db";
import { ForbiddenError, NotFoundError } from "@/lib/errors";
import { can } from "@/lib/rbac";
import { jsonRoute } from "@/server/api";
import { requireSchoolActor } from "@/server/auth/session";
import { getI18n } from "@/i18n/server";

/** iCalendar text: escape \ ; , and newlines (RFC 5545 §3.3.11). */
const esc = (s: string) => s.replace(/\\/g, "\\\\").replace(/;/g, "\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");
const stamp = (d: Date) => d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");

/** GET /api/lessons/:id/ics — "Add to calendar" file for a lesson (the student's own, the instructor's own, or staff). */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  let file: string | null = null;
  const res = await jsonRoute(async () => {
    const { id } = z.object({ id: z.string().uuid() }).parse(await params);
    const actor = await requireSchoolActor();
    const { t } = await getI18n();
    const l = await withTenant(actor.schoolId, (tx) =>
      one<{ id: string; student_id: string; instructor_id: string; start_time: Date; end_time: Date; lesson_number: number; instructor: string; student: string; vehicle: string | null; school: string }>(
        tx,
        `SELECT l.id, l.student_id, l.instructor_id, l.start_time, l.end_time, l.lesson_number,
                i.first_name || ' ' || i.last_name AS instructor, s.first_name || ' ' || s.last_name AS student,
                CASE WHEN v.id IS NULL THEN NULL ELSE v.brand || ' ' || v.model END AS vehicle, sc.name AS school
           FROM lessons l JOIN instructors i ON i.id = l.instructor_id JOIN students s ON s.id = l.student_id
           JOIN schools sc ON sc.id = l.school_id LEFT JOIN vehicles v ON v.id = l.vehicle_id
          WHERE l.id = $1`,
        [id],
      ),
    );
    if (!l) throw new NotFoundError("Lesson");
    const isStudent = actor.role === "student" && actor.studentId === l.student_id;
    const isInstructor = actor.role === "instructor" && actor.instructorId === l.instructor_id;
    if (!isStudent && !isInstructor && !can(actor.role, "lessons:read_all")) throw new ForbiddenError();
    const title = `${t("common.lessonNo", { number: l.lesson_number })} · ${l.school}`;
    const who = isStudent ? `${t("common.instructor")}: ${l.instructor}` : `${t("common.student")}: ${l.student}`;
    const desc = [who, l.vehicle ? `${t("common.vehicle")}: ${l.vehicle}` : null].filter(Boolean).join("\n");
    file = [
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "PRODID:-//DriveDesk//Lessons//EN",
      "CALSCALE:GREGORIAN",
      "BEGIN:VEVENT",
      `UID:lesson-${l.id}@drivedesk`,
      `DTSTAMP:${stamp(new Date())}`,
      `DTSTART:${stamp(l.start_time)}`,
      `DTEND:${stamp(l.end_time)}`,
      `SUMMARY:${esc(title)}`,
      `DESCRIPTION:${esc(desc)}`,
      "BEGIN:VALARM",
      "TRIGGER:-PT1H",
      "ACTION:DISPLAY",
      `DESCRIPTION:${esc(title)}`,
      "END:VALARM",
      "END:VEVENT",
      "END:VCALENDAR",
      "",
    ].join("\r\n");
    return null;
  });
  if (file === null) return res;
  return new Response(file, {
    headers: {
      "Content-Type": "text/calendar; charset=utf-8",
      "Content-Disposition": `attachment; filename="lesson.ics"`,
      "Cache-Control": "private, no-store",
    },
  });
}
