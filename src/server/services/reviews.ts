/**
 * Student reviews of lessons. After a completed lesson the student can give a
 * rating (1–5) and notes. Reviews go to the school (owner and admins) and are
 * the basis of each instructor's rating there. Instructors do not see them.
 */
import { z } from "zod";
import { many, one, type Tx } from "@/lib/db";
import { ForbiddenError, NotFoundError, PolicyError } from "@/lib/errors";
import { can } from "@/lib/rbac";
import type { Principal } from "../principal";
import { audit } from "./audit";

export const reviewSchema = z.object({
  rating: z.coerce.number().int().min(1).max(5),
  comment: z.string().trim().max(2000).default(""),
});

export interface LessonReview { lesson_id: string; rating: number; comment: string | null; created_at: Date; updated_at: Date }

/** The student reviews one of their own completed lessons. They can change it later. */
export async function saveLessonReview(tx: Tx, p: Principal, lessonId: string, raw: z.input<typeof reviewSchema>) {
  if (p.type !== "user" || p.actor.role !== "student" || !p.actor.studentId) throw new ForbiddenError();
  const input = reviewSchema.parse(raw);
  const lesson = await one<{ id: string; student_id: string; instructor_id: string; status: string }>(
    tx,
    `SELECT id, student_id, instructor_id, status FROM lessons WHERE id = $1`,
    [lessonId],
  );
  if (!lesson || lesson.student_id !== p.actor.studentId) throw new NotFoundError("Lesson");
  if (lesson.status !== "completed") throw new PolicyError("You can review a lesson after it has taken place.", "invalid_status");
  await tx.query(
    `INSERT INTO lesson_reviews (school_id, lesson_id, student_id, instructor_id, rating, comment)
     VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (lesson_id) DO UPDATE SET rating = EXCLUDED.rating, comment = EXCLUDED.comment`,
    [p.schoolId, lessonId, lesson.student_id, lesson.instructor_id, input.rating, input.comment || null],
  );
  await audit(tx, p, "lesson.reviewed", "lesson", lessonId, { rating: input.rating });
}

/** A student's own review of a lesson (null if none). */
export async function ownReview(tx: Tx, p: Principal, lessonId: string) {
  if (p.type !== "user" || p.actor.role !== "student") throw new ForbiddenError();
  return one<LessonReview>(tx, `SELECT lesson_id, rating, comment, created_at, updated_at FROM lesson_reviews WHERE lesson_id = $1 AND student_id = $2`, [lessonId, p.actor.studentId]);
}

const canSeeReviews = (p: Principal) => p.type === "system" || (p.type === "user" && can(p.actor.role, "students:read_all"));

/** Reviews for lessons (school staff only): lessonId -> review. */
export async function reviewsForLessons(tx: Tx, p: Principal, lessonIds: string[]) {
  const out = new Map<string, LessonReview>();
  if (!canSeeReviews(p) || !lessonIds.length) return out;
  for (const r of await many<LessonReview>(tx, `SELECT lesson_id, rating, comment, created_at, updated_at FROM lesson_reviews WHERE lesson_id = ANY($1::uuid[])`, [lessonIds])) out.set(r.lesson_id, r);
  return out;
}

/** Average rating per instructor from student reviews (school staff only). */
export async function instructorRatings(tx: Tx, p: Principal) {
  if (!canSeeReviews(p)) throw new ForbiddenError();
  const rows = await many<{ instructor_id: string; avg: string; n: number }>(
    tx,
    `SELECT instructor_id, avg(rating)::numeric(3,2)::text AS avg, count(*)::int AS n FROM lesson_reviews GROUP BY instructor_id`,
  );
  return new Map(rows.map((r) => [r.instructor_id, { avg: Number(r.avg), count: r.n }]));
}

/** Latest reviews of one instructor, with the student's name (school staff only). */
export async function recentReviews(tx: Tx, p: Principal, instructorId: string, limit = 20) {
  if (!canSeeReviews(p)) throw new ForbiddenError();
  return many<{ lesson_id: string; rating: number; comment: string | null; created_at: Date; student_id: string; student_name: string; lesson_number: number; start_time: Date }>(
    tx,
    `SELECT r.lesson_id, r.rating, r.comment, r.created_at, s.id AS student_id, s.first_name || ' ' || s.last_name AS student_name, l.lesson_number, l.start_time
       FROM lesson_reviews r JOIN students s ON s.id = r.student_id JOIN lessons l ON l.id = r.lesson_id
      WHERE r.instructor_id = $1 ORDER BY r.created_at DESC LIMIT $2`,
    [instructorId, limit],
  );
}
