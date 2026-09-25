import { many, one, type Tx } from "@/lib/db";
import { ForbiddenError, NotFoundError, ValidationError } from "@/lib/errors";
import { can } from "@/lib/rbac";
import type { Principal } from "../principal";
import { audit } from "./audit";

export type SkillStatus = "not_started" | "in_progress" | "needs_improvement" | "completed";
export interface SkillUpdate {
  skillId: string;
  status: SkillStatus;
}

/** Instructors may update progress only for students they teach (have a lesson with). */
export async function assertCanUpdateProgress(tx: Tx, p: Principal, studentId: string) {
  if (p.type === "system") return;
  if (p.type !== "user" || !can(p.actor.role, "students:update_progress")) throw new ForbiddenError();
  if (p.actor.role !== "instructor") return;
  const teaches = await one(
    tx,
    `SELECT 1 FROM students s WHERE s.id = $1 AND (s.primary_instructor_id = $2
       OR EXISTS (SELECT 1 FROM lessons l WHERE l.student_id = s.id AND l.instructor_id = $2))`,
    [studentId, p.actor.instructorId],
  );
  if (!teaches) throw new ForbiddenError("You can only update progress for your own students.");
}

export async function applyProgressUpdate(
  tx: Tx,
  p: Principal,
  args: { studentId: string; lessonId: string | null; skills: SkillUpdate[]; newLevelId: string | null; reason?: string },
) {
  await assertCanUpdateProgress(tx, p, args.studentId);
  const userId = p.type === "user" ? p.actor.userId : null;

  for (const s of args.skills) {
    await tx.query(
      `INSERT INTO student_skill_progress (school_id, student_id, skill_id, status, lesson_id, updated_by)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (student_id, skill_id) DO UPDATE SET status = EXCLUDED.status, lesson_id = EXCLUDED.lesson_id,
         updated_by = EXCLUDED.updated_by, updated_at = now()`,
      [p.schoolId, args.studentId, s.skillId, s.status, args.lessonId, userId],
    );
  }

  if (args.newLevelId) {
    const student = await one<{ current_level_id: string | null }>(tx, `SELECT current_level_id FROM students WHERE id = $1 FOR UPDATE`, [args.studentId]);
    if (!student) throw new NotFoundError("Student");
    const level = await one(tx, `SELECT 1 FROM level_definitions WHERE id = $1`, [args.newLevelId]);
    if (!level) throw new ValidationError("Unknown level");
    if (student.current_level_id !== args.newLevelId) {
      await tx.query(`UPDATE students SET current_level_id = $2, level_confirmed = true WHERE id = $1`, [args.studentId, args.newLevelId]);
      await tx.query(
        `INSERT INTO student_level_history (school_id, student_id, from_level_id, to_level_id, source, changed_by, lesson_id, reason)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [p.schoolId, args.studentId, student.current_level_id, args.newLevelId, p.type === "user" && p.actor.role === "instructor" ? "instructor" : "admin", userId, args.lessonId, args.reason ?? null],
      );
    } else {
      await tx.query(`UPDATE students SET level_confirmed = true WHERE id = $1`, [args.studentId]);
    }
  }
  await audit(tx, p, "student.progress_updated", "student", args.studentId, { skills: args.skills.length, level: args.newLevelId });
}

export interface ProgressSummary {
  currentLevel: { id: string; name: string; position: number; description: string | null } | null;
  levelConfirmed: boolean;
  totalLevels: number;
  skills: Array<{ id: string; name: string; level_position: number; status: SkillStatus }>;
  completed: string[];
  needsImprovement: string[];
  /** 0..1 overall progress through the programme. */
  percent: number;
}

export async function getProgressSummary(tx: Tx, studentId: string): Promise<ProgressSummary> {
  const student = await one<{ current_level_id: string | null; level_confirmed: boolean }>(
    tx,
    `SELECT current_level_id, level_confirmed FROM students WHERE id = $1`,
    [studentId],
  );
  if (!student) throw new NotFoundError("Student");
  const levels = await many<{ id: string; name: string; position: number; description: string | null }>(
    tx,
    `SELECT id, name, position, description FROM level_definitions ORDER BY position`,
  );
  const skills = await many<{ id: string; name: string; level_position: number; status: SkillStatus | null }>(
    tx,
    `SELECT sk.id, sk.name, ld.position AS level_position, sp.status
       FROM skills sk JOIN level_definitions ld ON ld.id = sk.level_id
       LEFT JOIN student_skill_progress sp ON sp.skill_id = sk.id AND sp.student_id = $1
      WHERE sk.is_active
      ORDER BY ld.position, sk.position`,
    [studentId],
  );
  const current = levels.find((l) => l.id === student.current_level_id) ?? null;
  const normalized = skills.map((s) => ({ ...s, status: s.status ?? "not_started" }));
  const totalSkills = normalized.length;
  const doneSkills = normalized.filter((s) => s.status === "completed").length;
  // Progress: completed levels + share of skills done, falling back to level position when no skills are defined.
  const percent =
    totalSkills > 0 ? doneSkills / totalSkills : current && levels.length ? current.position / levels.length : 0;
  return {
    currentLevel: current,
    levelConfirmed: student.level_confirmed,
    totalLevels: levels.length,
    skills: normalized,
    completed: normalized.filter((s) => s.status === "completed").map((s) => s.name),
    needsImprovement: normalized.filter((s) => s.status === "needs_improvement").map((s) => s.name),
    percent: Math.round(percent * 100) / 100,
  };
}
