import { describe, expect, it } from "vitest";
import { partOfDay, relativeWhen } from "@/lib/relative-time";
import { studentMilestones } from "@/lib/milestones";

const Z = "Europe/Amsterdam";
const now = new Date("2026-11-05T09:00:00Z"); // 10:00 in Amsterdam

describe("relativeWhen", () => {
  it("counts minutes and hours on the same day", () => {
    expect(relativeWhen(new Date("2026-11-05T09:25:00Z"), now, "en-GB", Z)).toBe("in 25 minutes");
    expect(relativeWhen(new Date("2026-11-05T12:00:00Z"), now, "en-GB", Z)).toBe("in 3 hours");
  });
  it("uses calendar days after today, in the school's time zone", () => {
    expect(relativeWhen(new Date("2026-11-06T07:00:00Z"), now, "en-GB", Z)).toBe("tomorrow");
    expect(relativeWhen(new Date("2026-11-09T07:00:00Z"), now, "en-GB", Z)).toBe("in 4 days");
    expect(relativeWhen(new Date("2026-11-06T07:00:00Z"), now, "nl-NL", Z)).toBe("morgen");
  });
  it("says now for a lesson that is starting", () => {
    expect(relativeWhen(now, now, "en-GB", Z)).toBe("now");
  });
});

describe("partOfDay", () => {
  it("follows the school's clock", () => {
    expect(partOfDay(new Date("2026-11-05T09:00:00Z"), Z)).toBe("morning");
    expect(partOfDay(new Date("2026-11-05T13:00:00Z"), Z)).toBe("afternoon");
    expect(partOfDay(new Date("2026-11-05T18:00:00Z"), Z)).toBe("evening");
  });
});

describe("studentMilestones", () => {
  it("is all locked for a new student, with progress towards the counts", () => {
    const m = studentMilestones({ lessons: 0, minutes: 0, ratings: [], levelPosition: null, totalLevels: 8 });
    expect(m.every((x) => !x.earned)).toBe(true);
    expect(m.find((x) => x.key === "fiveLessons")?.progress).toEqual([0, 5]);
  });
  it("earns milestones from lessons, hours, ratings and level", () => {
    const m = studentMilestones({ lessons: 7, minutes: 7 * 60, ratings: [3, 4, 5], levelPosition: 5, totalLevels: 8 });
    const earned = m.filter((x) => x.earned).map((x) => x.key);
    expect(earned).toEqual(["firstLesson", "fiveLessons", "topRated", "halfway"]);
    expect(m.find((x) => x.key === "tenHours")?.progress).toEqual([7, 10]);
  });
  it("is exam ready on the last level", () => {
    const m = studentMilestones({ lessons: 30, minutes: 1800, ratings: [5], levelPosition: 8, totalLevels: 8 });
    expect(m.every((x) => x.earned)).toBe(true);
  });
});
