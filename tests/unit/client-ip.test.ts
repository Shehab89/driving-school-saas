import { describe, expect, it } from "vitest";
import { clientIp } from "@/lib/rate-limit";

describe("clientIp", () => {
  const h = (xff?: string, real?: string) => new Headers({ ...(xff ? { "x-forwarded-for": xff } : {}), ...(real ? { "x-real-ip": real } : {}) });

  it("ignores addresses the client put in front of the chain", () => {
    expect(clientIp(h("1.2.3.4, 203.0.113.9"), 1)).toBe("203.0.113.9");
  });
  it("takes the entry written by the outermost trusted proxy", () => {
    expect(clientIp(h("1.2.3.4, 203.0.113.9, 10.0.0.2"), 2)).toBe("203.0.113.9");
  });
  it("falls back to x-real-ip, then unknown", () => {
    expect(clientIp(h(undefined, "198.51.100.7"), 1)).toBe("198.51.100.7");
    expect(clientIp(h(), 1)).toBe("unknown");
  });
});
