import { describe, expect, it } from "vitest";
import { pacer } from "@/server/email/provider";

describe("email pacer", () => {
  it("spaces calls to the allowed rate, in order", async () => {
    let clock = 0;
    const starts: number[] = [];
    const pace = pacer(2, () => clock, async (ms) => {
      clock += ms;
    });
    for (let i = 0; i < 5; i++) {
      await pace();
      starts.push(clock);
    }
    expect(starts).toEqual([0, 500, 1000, 1500, 2000]);
  });

  it("does not wait when calls are already far apart", async () => {
    let clock = 0;
    let waited = 0;
    const pace = pacer(2, () => clock, async (ms) => {
      waited += ms;
    });
    await pace();
    clock = 10_000;
    await pace();
    expect(waited).toBe(0);
  });
});
