/**
 * Students who need attention: active students without a next lesson planned.
 * A student with no lesson in the agenda is the most common way a school loses
 * hours (and money) without noticing, so the apps put them in front of the
 * instructor and the office.
 */
import { many, type Tx } from "@/lib/db";

export interface UnplannedStudent {
  id: string;
  name: string;
  phone: string | null;
  last_lesson: Date | null;
  lessons_done: number;
  credit: number;
}

/** Active students with no upcoming lesson. instructorId limits it to that instructor's students. */
export async function unplannedStudents(tx: Tx, instructorId: string | null, limit = 50): Promise<UnplannedStudent[]> {
  return many<UnplannedStudent>(
    tx,
    `SELECT s.id, s.first_name || ' ' || s.last_name AS name, s.phone,
            (SELECT max(start_time) FROM lessons l WHERE l.student_id = s.id AND l.status = 'completed') AS last_lesson,
            (SELECT count(*)::int FROM lessons l WHERE l.student_id = s.id AND l.status = 'completed') AS lessons_done,
            COALESCE((SELECT sum(delta) FROM student_credit_ledger c WHERE c.student_id = s.id), 0)::int AS credit
       FROM students s
      WHERE s.status = 'active'
        AND ($1::uuid IS NULL OR s.primary_instructor_id = $1
             OR (s.primary_instructor_id IS NULL AND EXISTS (SELECT 1 FROM lessons l WHERE l.student_id = s.id AND l.instructor_id = $1)))
        AND NOT EXISTS (SELECT 1 FROM lessons l WHERE l.student_id = s.id
                         AND l.status IN ('scheduled','confirmed','in_progress') AND l.end_time > now())
        AND NOT EXISTS (SELECT 1 FROM cbr_exams e WHERE e.student_id = s.id AND e.status = 'passed' AND e.product IN ('practical','practical_anxiety','practical_be'))
      ORDER BY last_lesson ASC NULLS FIRST, s.first_name
      LIMIT $2`,
    [instructorId, limit],
  );
}
