import { many, one, type Tx } from "@/lib/db";
import { ForbiddenError, NotFoundError, PolicyError } from "@/lib/errors";
import { can } from "@/lib/rbac";
import type { Principal } from "../principal";
import { audit } from "./audit";
import { BANDS, scoreAssessment, type AssessmentAnswers, type Band } from "./assessment-scoring";

/** Map a band to the school's own level scale. */
export async function levelForBand(tx: Tx, band: Band): Promise<{ id: string; name: string } | null> {
  const explicit = await one<{ id: string; name: string }>(tx, `SELECT id, name FROM level_definitions WHERE assessment_band = $1`, [band]);
  if (explicit) return explicit;
  const levels = await many<{ id: string; name: string }>(tx, `SELECT id, name FROM level_definitions ORDER BY position`);
  if (levels.length === 0) return null;
  // Spread the four bands over however many levels the school has.
  const idx = Math.min(levels.length - 1, Math.floor((BANDS.indexOf(band) / BANDS.length) * levels.length));
  return levels[idx]!;
}

export async function createAssessment(
  tx: Tx,
  p: Principal,
  args: { studentId: string; answers: AssessmentAnswers; source: "whatsapp_agent" | "web_form" | "instructor" },
) {
  const result = scoreAssessment(args.answers);
  const level = await levelForBand(tx, result.band);
  const row = (await one<{ id: string }>(
    tx,
    `INSERT INTO assessments (school_id, student_id, source, answers, suggested_band, suggested_level_id, confidence, rationale)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
    [p.schoolId, args.studentId, args.source, JSON.stringify(args.answers), result.band, level?.id ?? null, result.confidence, result.rationale.join(" ")],
  ))!;
  // Use the suggestion as a provisional starting level only if nobody has set one.
  if (level) {
    await tx.query(
      `UPDATE students SET current_level_id = $2, level_confirmed = false,
              preferred_transmission = $3
        WHERE id = $1 AND (current_level_id IS NULL OR level_confirmed = false)`,
      [args.studentId, level.id, args.answers.wants_transmission],
    );
  }
  await audit(tx, p, "assessment.created", "assessment", row.id, { band: result.band, confidence: result.confidence });
  return { id: row.id, ...result, level };
}

/** School confirms the suggestion or overrides it with another level. */
export async function reviewAssessment(tx: Tx, p: Principal, assessmentId: string, finalLevelId: string, reason?: string) {
  if (p.type !== "user" || !can(p.actor.role, "assessments:review")) throw new ForbiddenError();
  const a = await one<{ id: string; student_id: string; suggested_level_id: string | null; status: string }>(
    tx,
    `SELECT id, student_id, suggested_level_id, status FROM assessments WHERE id = $1 FOR UPDATE`,
    [assessmentId],
  );
  if (!a) throw new NotFoundError("Assessment");
  if (a.status !== "suggested") throw new PolicyError("This assessment was already reviewed.", "already_reviewed");
  const status = finalLevelId === a.suggested_level_id ? "confirmed" : "overridden";
  await tx.query(
    `UPDATE assessments SET status = $2, final_level_id = $3, reviewed_by = $4, reviewed_at = now(), override_reason = $5 WHERE id = $1`,
    [assessmentId, status, finalLevelId, p.actor.userId, reason ?? null],
  );
  const s = await one<{ current_level_id: string | null }>(tx, `SELECT current_level_id FROM students WHERE id = $1 FOR UPDATE`, [a.student_id]);
  await tx.query(`UPDATE students SET current_level_id = $2, level_confirmed = true WHERE id = $1`, [a.student_id, finalLevelId]);
  await tx.query(
    `INSERT INTO student_level_history (school_id, student_id, from_level_id, to_level_id, source, changed_by, reason)
     VALUES ($1,$2,$3,$4,'assessment',$5,$6)`,
    [p.schoolId, a.student_id, s?.current_level_id ?? null, finalLevelId, p.actor.userId, reason ?? `Assessment ${status}`],
  );
  await audit(tx, p, `assessment.${status}`, "assessment", assessmentId, { final_level_id: finalLevelId, reason });
}
