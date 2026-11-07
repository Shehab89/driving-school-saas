import { describe, expect, it } from "vitest";
import { cancelDeadline, cbrChecklist, passRate, readyToReserve, theoryValidUntil } from "@/lib/cbr";

describe("CBR rules", () => {
  it("theory certificate is valid for 18 months", () => {
    expect(theoryValidUntil("2026-03-15")).toBe("2027-09-15");
    expect(theoryValidUntil("2025-08-31")).toBe("2027-02-28");
    expect(theoryValidUntil("2026-12-01")).toBe("2028-06-01");
  });

  it("cancelling is possible until 4 weeks before the exam", () => {
    expect(cancelDeadline(new Date("2026-12-30T09:00:00Z")).toISOString()).toBe("2026-12-02T09:00:00.000Z");
  });

  it("a practical exam needs authorisation, a valid theory certificate and an approved health declaration", () => {
    const none = { theoryPassedOn: null, health: "unknown" as const, authorizedOn: null };
    expect(cbrChecklist(none, "practical", "2026-11-07").filter((c) => c.blocking).map((c) => c.key).sort()).toEqual(["authorization", "health", "theory"]);
    const ready = { theoryPassedOn: "2026-06-01", health: "approved" as const, authorizedOn: "2026-06-02" };
    expect(readyToReserve(ready, "practical", "2026-11-07")).toBe(true);
    // Expired theory blocks a practical exam, not an interim test.
    const expired = { ...ready, theoryPassedOn: "2024-01-10" };
    expect(readyToReserve(expired, "practical", "2026-11-07")).toBe(false);
    expect(cbrChecklist(expired, "practical", "2026-11-07").find((c) => c.key === "theory")?.detail).toEqual({ until: "2025-07-10", expired: true });
    expect(readyToReserve(expired, "interim_test", "2026-11-07")).toBe(true);
    // The theory exam itself has no prerequisites here.
    expect(cbrChecklist(none, "theory")).toEqual([]);
  });

  it("pass rate counts practical exams only", () => {
    expect(passRate([
      { product: "practical", status: "passed" },
      { product: "practical", status: "failed" },
      { product: "practical_anxiety", status: "passed" },
      { product: "interim_test", status: "failed" },
      { product: "practical", status: "cancelled" },
    ])).toEqual({ rate: 2 / 3, taken: 3, passed: 2 });
    expect(passRate([]).rate).toBeNull();
  });
});
