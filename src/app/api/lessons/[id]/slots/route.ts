import { z } from "zod";
import { one, withTenant } from "@/lib/db";
import { NotFoundError, ForbiddenError } from "@/lib/errors";
import { can } from "@/lib/rbac";
import { jsonRoute } from "@/server/api";
import { requireSchoolActor } from "@/server/auth/session";
import { checkStudentReschedule } from "@/server/policies";
import { dbNow, loadSchoolContext, searchSlots } from "@/server/scheduling/loader";

/** GET /api/lessons/:id/slots — alternative times for a lesson (student self-service or staff). */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  return jsonRoute(async () => {
    const { id } = z.object({ id: z.string().uuid() }).parse(await params);
    const actor = await requireSchoolActor();
    return withTenant(actor.schoolId, async (tx) => {
      const l = await one<{ student_id: string; instructor_id: string; start_time: Date; end_time: Date; status: string }>(
        tx,
        `SELECT student_id, instructor_id, start_time, end_time, status FROM lessons WHERE id = $1`,
        [id],
      );
      if (!l) throw new NotFoundError("Lesson");
      const isStudent = actor.role === "student" && actor.studentId === l.student_id;
      const isInstructor = actor.role === "instructor" && actor.instructorId === l.instructor_id;
      if (!isStudent && !isInstructor && !can(actor.role, "lessons:write_all")) throw new ForbiddenError();
      const ctx = await loadSchoolContext(tx, actor.schoolId);
      const policy = checkStudentReschedule({ lessonStart: l.start_time, status: l.status as "scheduled", now: await dbNow(tx), noticeHours: ctx.settings.min_reschedule_notice_hours, timezone: ctx.timezone });
      if (isStudent && !policy.allowed) return { allowed: false, reason: policy.code, message: policy.message, slots: [] };
      const slots = await searchSlots(tx, ctx, {
        studentId: l.student_id,
        durationMinutes: Math.round((l.end_time.getTime() - l.start_time.getTime()) / 60000),
        ignoreLessonIds: [id],
        distinctTimes: isStudent,
        instructorIds: isInstructor ? [l.instructor_id] : undefined,
        maxSlots: 60,
      });
      return { allowed: true, deadline: policy.allowed ? policy.deadline : null, timezone: ctx.timezone, slots };
    });
  });
}
