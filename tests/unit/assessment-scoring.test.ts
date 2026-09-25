import { describe, expect, it } from "vitest";
import { scoreAssessment, assessmentAnswersSchema } from "@/server/services/assessment-scoring";

describe("scoreAssessment", () => {
  it("classifies a complete novice as beginner", () => {
    const r = scoreAssessment({ has_driven_before: false, previous_lessons: "none", can_drive_manual: "no", traffic_comfort: 2, wants_transmission: "manual" });
    expect(r.band).toBe("beginner");
    expect(r.confidence).toBeLessThanOrEqual(0.85);
  });

  it("classifies some experience as basic", () => {
    expect(scoreAssessment({ has_driven_before: true, previous_lessons: "few", can_drive_manual: "unsure", traffic_comfort: 3, wants_transmission: "manual" }).band).toBe("basic");
  });

  it("classifies substantial experience as intermediate", () => {
    const r = scoreAssessment({ has_driven_before: true, previous_lessons: "some", approx_driving_hours: 15, can_drive_manual: "yes", traffic_comfort: 4, wants_transmission: "manual" });
    expect(r.band).toBe("intermediate");
  });

  it("classifies a foreign licence holder as advanced", () => {
    const r = scoreAssessment({ has_driven_before: true, previous_lessons: "many", approx_driving_hours: 200, can_drive_manual: "yes", traffic_comfort: 5, has_foreign_license: true, wants_transmission: "manual" });
    expect(r.band).toBe("advanced");
  });

  it("never rates a nervous driver above basic", () => {
    const r = scoreAssessment({ has_driven_before: true, previous_lessons: "many", approx_driving_hours: 60, can_drive_manual: "yes", traffic_comfort: 1, wants_transmission: "manual" });
    expect(r.band).toBe("basic");
    expect(r.confidence).toBeLessThan(0.6); // inconsistent answers lower confidence
  });

  it("caps manual learners who cannot drive manual yet", () => {
    const r = scoreAssessment({ has_driven_before: true, previous_lessons: "many", approx_driving_hours: 200, can_drive_manual: "no", traffic_comfort: 5, has_foreign_license: true, wants_transmission: "manual" });
    expect(r.band).toBe("intermediate");
  });

  it("rejects unexpected fields", () => {
    expect(assessmentAnswersSchema.safeParse({ has_driven_before: true, previous_lessons: "few", can_drive_manual: "yes", traffic_comfort: 3, wants_transmission: "manual", level: "advanced" }).success).toBe(false);
  });
});
