/**
 * Lesson feedback: instructors write it (at completion or later, from the
 * Feedback tab), students read it in their app. Only the lesson's own
 * instructor (or school staff) may write; students only see feedback marked
 * visible, and never the private instructor note.
 */
import { z } from "zod";
import { DateTime } from "luxon";
import { many, one, type Tx } from "@/lib/db";
import { ForbiddenError, PolicyError } from "@/lib/errors";
import { can } from "@/lib/rbac";
import type { Principal } from "../principal";
import { assertLessonAccess, lessonSnapshot, lockLesson } from "./lessons";
import { applyProgressUpdate } from "./progress";
import { enqueueNotification } from "./notifications";
import { audit } from "./audit";
import { env } from "@/lib/env";

export const feedbackSchema = z.object({
  strengths: z.string().trim().max(2000).default(""),
  weaknesses: z.string().trim().max(2000).default(""),
  practiceItems: z.string().trim().max(2000).default(""),
  nextFocus: z.string().trim().max(500).default(""),
  instructorNotes: z.string().trim().max(4000).default(""),
  overallRating: z.number().int().min(1).max(5).nullable().default(null),
  visibleToStudent: z.boolean().default(true),
  skills: z
    .array(z.object({ skillId: z.string().uuid(), status: z.enum(["in_progress", "needs_improvement", "completed"]) }))
    .max(100)
    .default([]),
  newLevelId: z.string().uuid().nullable().default(null),
});
export type FeedbackInput = z.input<typeof feedbackSchema>;

const WRITABLE = ["in_progress", "completed"];

export async function saveLessonFeedback(tx: Tx, p: Principal, lessonId: string, raw: FeedbackInput) {
  const input = feedbackSchema.parse(raw);
  if (p.type === "user" && !can(p.actor.role, "lessons:feedback_own")) throw new ForbiddenError();
  if (p.type === "ai_agent" || p.type === "webhook") throw new ForbiddenError();
  const lesson = await lockLesson(tx, lessonId);
  assertLessonAccess(p, lesson, "operate");
  if (!WRITABLE.includes(lesson.status)) {
    throw new PolicyError("Feedback can be given once the lesson has started or is completed.", "invalid_status");
  }
  const before = await one<{ strengths: string | null; weaknesses: string | null; practice_items: string | null; next_focus: string | null; visible_to_student: boolean }>(
    tx,
    `SELECT strengths, weaknesses, practice_items, next_focus, visible_to_student FROM lesson_feedback WHERE lesson_id = $1`,
    [lessonId],
  );
  const studentFacingChanged =
    !before ||
    before.strengths !== (input.strengths || null) ||
    before.weaknesses !== (input.weaknesses || null) ||
    before.practice_items !== (input.practiceItems || null) ||
    before.next_focus !== (input.nextFocus || null) ||
    before.visible_to_student !== input.visibleToStudent;
  const userId = p.type === "user" ? p.actor.userId : null;

  await tx.query(
    `INSERT INTO lesson_feedback (school_id, lesson_id, student_id, instructor_id, overall_level_id, overall_rating,
                                  strengths, weaknesses, practice_items, next_focus, instructor_notes, visible_to_student, updated_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
     ON CONFLICT (lesson_id) DO UPDATE SET
       overall_level_id = COALESCE(EXCLUDED.overall_level_id, lesson_feedback.overall_level_id),
       overall_rating = EXCLUDED.overall_rating, strengths = EXCLUDED.strengths, weaknesses = EXCLUDED.weaknesses,
       practice_items = EXCLUDED.practice_items, next_focus = EXCLUDED.next_focus, instructor_notes = EXCLUDED.instructor_notes,
       visible_to_student = EXCLUDED.visible_to_student, updated_by = EXCLUDED.updated_by,
       -- The student sees it as "new" again when what they can read has changed.
       seen_at = CASE WHEN $14 THEN NULL ELSE lesson_feedback.seen_at END`,
    [
      p.schoolId,
      lessonId,
      lesson.student_id,
      lesson.instructor_id,
      input.newLevelId,
      input.overallRating,
      input.strengths || null,
      input.weaknesses || null,
      input.practiceItems || null,
      input.nextFocus || null,
      input.instructorNotes || null,
      input.visibleToStudent,
      userId,
      studentFacingChanged,
    ],
  );

  if (input.skills.length || input.newLevelId) {
    await applyProgressUpdate(tx, p, { studentId: lesson.student_id, lessonId, skills: input.skills, newLevelId: input.newLevelId });
  }

  const hasContent = Boolean(input.strengths || input.weaknesses || input.practiceItems || input.nextFocus);
  if (input.visibleToStudent && hasContent && studentFacingChanged) {
    const snap = await lessonSnapshot(tx, lessonId);
    await enqueueNotification(tx, {
      schoolId: p.schoolId,
      type: "feedback_received",
      to: snap?.student_email,
      studentId: lesson.student_id,
      lessonId,
      payload: { lesson: snap, next_focus: input.nextFocus, app_url: `${env.appUrl}/student/feedback` },
      // At most one e-mail per lesson per hour, however often the instructor edits.
      dedupeKey: `feedback:${lessonId}:${DateTime.utc().toFormat("yyyyLLddHH")}`,
    });
  }
  await audit(tx, p, before ? "feedback.updated" : "feedback.created", "lesson", lessonId, { visible: input.visibleToStudent });
  return { studentId: lesson.student_id };
}

export interface FeedbackQueueItem {
  lesson_id: string;
  start_time: Date;
  end_time: Date;
  lesson_number: number;
  student_id: string;
  student_name: string;
  has_feedback: boolean;
  visible_to_student: boolean | null;
  seen_at: Date | null;
  overall_rating: number | null;
  next_focus: string | null;
  updated_at: Date | null;
}

/** Instructor's Feedback tab: completed lessons still without feedback, and what they recently wrote. */
export async function feedbackQueue(tx: Tx, instructorId: string) {
  const base = `SELECT l.id AS lesson_id, l.start_time, l.end_time, l.lesson_number, s.id AS student_id,
                       s.first_name || ' ' || s.last_name AS student_name, (f.id IS NOT NULL) AS has_feedback,
                       f.visible_to_student, f.seen_at, f.overall_rating, f.next_focus, f.updated_at
                  FROM lessons l JOIN students s ON s.id = l.student_id LEFT JOIN lesson_feedback f ON f.lesson_id = l.id`;
  const waiting = await many<FeedbackQueueItem>(
    tx,
    `${base}
      WHERE l.instructor_id = $1 AND l.status IN ('completed','in_progress') AND l.start_time > now() - interval '45 days'
        AND (f.id IS NULL OR COALESCE(f.strengths, f.weaknesses, f.practice_items, f.next_focus) IS NULL)
      ORDER BY l.start_time DESC`,
    [instructorId],
  );
  const recent = await many<FeedbackQueueItem>(
    tx,
    `${base}
      WHERE f.instructor_id = $1 AND COALESCE(f.strengths, f.weaknesses, f.practice_items, f.next_focus) IS NOT NULL
      ORDER BY f.updated_at DESC, l.start_time DESC LIMIT 20`,
    [instructorId],
  );
  return { waiting, recent };
}

export interface StudentFeedback {
  lesson_id: string;
  lesson_number: number;
  start_time: Date;
  instructor_name: string;
  overall_rating: number | null;
  strengths: string | null;
  weaknesses: string | null;
  practice_items: string | null;
  next_focus: string | null;
  seen_at: Date | null;
}

/** Everything a student may read (visible feedback, never the private note). */
export async function feedbackForStudent(tx: Tx, studentId: string) {
  return many<StudentFeedback>(
    tx,
    `SELECT f.lesson_id, l.lesson_number, l.start_time, i.first_name AS instructor_name, f.overall_rating,
            f.strengths, f.weaknesses, f.practice_items, f.next_focus, f.seen_at
       FROM lesson_feedback f JOIN lessons l ON l.id = f.lesson_id JOIN instructors i ON i.id = f.instructor_id
      WHERE f.student_id = $1 AND f.visible_to_student
        AND COALESCE(f.strengths, f.weaknesses, f.practice_items, f.next_focus) IS NOT NULL
      ORDER BY l.start_time DESC`,
    [studentId],
  );
}

export async function unseenFeedbackCount(tx: Tx, studentId: string) {
  return (await one<{ n: number }>(
    tx,
    `SELECT count(*)::int AS n FROM lesson_feedback WHERE student_id = $1 AND visible_to_student AND seen_at IS NULL
        AND COALESCE(strengths, weaknesses, practice_items, next_focus) IS NOT NULL`,
    [studentId],
  ))!.n;
}

export async function markFeedbackSeen(tx: Tx, p: Principal, studentId: string) {
  if (p.type !== "user" || p.actor.studentId !== studentId) return;
  await tx.query(`UPDATE lesson_feedback SET seen_at = now() WHERE student_id = $1 AND seen_at IS NULL AND visible_to_student`, [studentId]);
}

export async function waitingFeedbackCount(tx: Tx, instructorId: string) {
  return (await one<{ n: number }>(
    tx,
    `SELECT count(*)::int AS n FROM lessons l LEFT JOIN lesson_feedback f ON f.lesson_id = l.id
      WHERE l.instructor_id = $1 AND l.status = 'completed' AND l.start_time > now() - interval '45 days'
        AND (f.id IS NULL OR COALESCE(f.strengths, f.weaknesses, f.practice_items, f.next_focus) IS NULL)`,
    [instructorId],
  ))!.n;
}
