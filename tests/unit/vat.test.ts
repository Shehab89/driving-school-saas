import { describe, expect, it } from "vitest";
import { splitVat } from "@/lib/vat";

describe("VAT split", () => {
  it("splits a VAT-inclusive price (21%)", () => {
    expect(splitVat(5500, 2100, true)).toEqual({ netCents: 4545, vatCents: 955, grossCents: 5500 });
    expect(splitVat(12100, 2100, true)).toEqual({ netCents: 10000, vatCents: 2100, grossCents: 12100 });
  });
  it("adds VAT to an exclusive price", () => {
    expect(splitVat(4545, 2100, false)).toEqual({ netCents: 4545, vatCents: 954, grossCents: 5499 });
    expect(splitVat(10000, 900, false)).toEqual({ netCents: 10000, vatCents: 900, grossCents: 10900 });
  });
  it("handles zero VAT (exempt or small-business scheme)", () => {
    expect(splitVat(5500, 0, true)).toEqual({ netCents: 5500, vatCents: 0, grossCents: 5500 });
  });
  it("net + VAT always equals gross", () => {
    for (let c = 0; c < 20000; c += 37) {
      const s = splitVat(c, 2100, true);
      expect(s.netCents + s.vatCents).toBe(c);
    }
  });
  it("rejects invalid input", () => {
    expect(() => splitVat(-1, 2100, true)).toThrow();
    expect(() => splitVat(100, 20000, true)).toThrow();
    expect(() => splitVat(1.5, 2100, true)).toThrow();
  });
});
