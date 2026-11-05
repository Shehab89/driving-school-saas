/**
 * Small milestones shown on the student's home screen, so progress feels
 * visible between levels (the same idea fitness and language apps use).
 * Pure: computed from numbers the dashboard already loads.
 */
export const MILESTONES = ["firstLesson", "fiveLessons", "tenHours", "topRated", "halfway", "examReady"] as const;
export type MilestoneKey = (typeof MILESTONES)[number];
export interface Milestone {
  key: MilestoneKey;
  earned: boolean;
  /** [current, goal] for count-based milestones that are not earned yet. */
  progress?: [number, number];
}

export function studentMilestones(input: { lessons: number; minutes: number; ratings: number[]; levelPosition: number | null; totalLevels: number }): Milestone[] {
  const { lessons, minutes, ratings, levelPosition, totalLevels } = input;
  const level = levelPosition ?? 0;
  const half = Math.max(1, Math.ceil(totalLevels / 2));
  const count = (key: MilestoneKey, value: number, goal: number): Milestone =>
    value >= goal ? { key, earned: true } : { key, earned: false, progress: [Math.max(0, Math.floor(value)), goal] };
  return [
    count("firstLesson", lessons, 1),
    count("fiveLessons", lessons, 5),
    count("tenHours", minutes / 60, 10),
    { key: "topRated", earned: ratings.some((r) => r >= 5) },
    totalLevels > 0 ? count("halfway", level, half) : { key: "halfway", earned: false },
    { key: "examReady", earned: totalLevels > 0 && level >= totalLevels },
  ];
}
