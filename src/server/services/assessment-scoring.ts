/**
 * Deterministic initial-level suggestion from a short self-assessment.
 *
 * The AI agent only *collects* the answers; this function decides the band,
 * so the outcome is explainable, testable and cannot be talked into a
 * different result. It is always a suggestion: confidence is capped below 1
 * and the school confirms or overrides it (assessments.status).
 */
import { z } from "zod";

export const assessmentAnswersSchema = z
  .object({
    has_driven_before: z.boolean(),
    previous_lessons: z.enum(["none", "few", "some", "many"]).describe("none; few = under 10; some = 10–20; many = over 20"),
    approx_driving_hours: z.number().min(0).max(10000).nullable().optional(),
    can_drive_manual: z.enum(["yes", "no", "unsure"]),
    traffic_comfort: z.number().int().min(1).max(5).describe("1 = very nervous … 5 = fully comfortable"),
    has_foreign_license: z.boolean().optional(),
    wants_transmission: z.enum(["manual", "automatic"]),
    notes: z.string().max(1000).optional(),
  })
  .strict();

export type AssessmentAnswers = z.infer<typeof assessmentAnswersSchema>;
export type Band = "beginner" | "basic" | "intermediate" | "advanced";
export const BANDS: Band[] = ["beginner", "basic", "intermediate", "advanced"];

export interface AssessmentResult {
  band: Band;
  confidence: number;
  rationale: string[];
}

const rank = (b: Band) => BANDS.indexOf(b);
const minBand = (a: Band, b: Band) => (rank(a) <= rank(b) ? a : b);

export function scoreAssessment(a: AssessmentAnswers): AssessmentResult {
  const why: string[] = [];
  let points = 0;

  if (a.has_driven_before) points += 1;
  points += { none: 0, few: 1, some: 2, many: 3 }[a.previous_lessons];
  const hours = a.approx_driving_hours ?? null;
  if (hours !== null) points += hours >= 40 ? 3 : hours >= 20 ? 2 : hours >= 5 ? 1 : 0;
  points += a.traffic_comfort >= 4 ? 2 : a.traffic_comfort === 3 ? 1 : 0;
  if (a.has_foreign_license) points += 2;
  if (a.wants_transmission === "manual") points += a.can_drive_manual === "yes" ? 1 : a.can_drive_manual === "no" ? -1 : 0;

  let band: Band = points <= 1 ? "beginner" : points <= 4 ? "basic" : points <= 7 ? "intermediate" : "advanced";
  why.push(`Experience score ${points}.`);

  // Safety caps: never over-estimate.
  if (!a.has_driven_before && a.previous_lessons === "none") {
    band = "beginner";
    why.push("No previous driving experience.");
  }
  if (a.traffic_comfort <= 2) {
    band = minBand(band, "basic");
    why.push("Low comfort in traffic.");
  }
  if (a.wants_transmission === "manual" && a.can_drive_manual === "no") {
    band = minBand(band, "intermediate");
    why.push("Has not yet learned to drive a manual car.");
  }
  if (a.previous_lessons === "none" && !a.has_foreign_license) {
    band = minBand(band, "basic");
  }

  // Confidence: self-reported data is uncertain; less so when answers are consistent and complete.
  let confidence = 0.6;
  if (hours !== null) confidence += 0.1;
  if (a.can_drive_manual !== "unsure") confidence += 0.05;
  const inconsistent =
    (a.previous_lessons === "many" && a.traffic_comfort <= 2) ||
    (!a.has_driven_before && (a.previous_lessons === "many" || (hours ?? 0) >= 20));
  if (inconsistent) {
    confidence -= 0.25;
    why.push("Some answers look inconsistent; an instructor should check.");
  }
  confidence = Math.max(0.2, Math.min(0.85, Math.round(confidence * 100) / 100));
  return { band, confidence, rationale: why };
}
