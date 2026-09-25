import { describe, expect, it } from "vitest";
import en from "@/i18n/en";
import nl from "@/i18n/nl";
import ar from "@/i18n/ar";
import { dir, formatter, negotiate, translator } from "@/i18n";

function keys(o: object, p = ""): string[] {
  return Object.entries(o).flatMap(([k, v]) => (typeof v === "string" ? [`${p}${k}`] : keys(v as object, `${p}${k}.`)));
}
function placeholders(s: string) {
  return (s.match(/\{\w+\}/g) ?? []).sort().join(",");
}

describe("i18n", () => {
  it("every language has every key, and the same placeholders", () => {
    const all = keys(en);
    for (const dict of [nl, ar]) {
      expect(keys(dict).sort()).toEqual([...all].sort());
      for (const k of all) {
        const get = (d: object) => k.split(".").reduce<unknown>((n, part) => (n as Record<string, unknown>)[part], d) as string;
        expect(placeholders(get(dict)), k).toBe(placeholders(get(en)));
        expect(get(dict).trim().length, k).toBeGreaterThan(0);
      }
    }
  });

  it("interpolates and falls back", () => {
    expect(translator("nl")("common.lessonNo", { number: 14 })).toBe("Les 14");
    expect(translator("ar")("common.levelOf", { position: 3, total: 5 })).toBe("المستوى 3 من 5");
  });

  it("negotiates Accept-Language", () => {
    expect(negotiate("ar-MA,ar;q=0.9,en;q=0.5")).toBe("ar");
    expect(negotiate("de-DE,nl;q=0.8,en;q=0.7")).toBe("nl");
    expect(negotiate("fr-FR")).toBe("en");
    expect(negotiate(null)).toBe("en");
  });

  it("marks Arabic as right-to-left and formats dates per locale", () => {
    expect(dir("ar")).toBe("rtl");
    expect(dir("nl")).toBe("ltr");
    const d = "2026-09-28T12:00:00Z";
    expect(formatter("nl", "Europe/Amsterdam").date(d)).toBe("maandag 28 september 2026");
    expect(formatter("ar", "Europe/Amsterdam").time(d)).toBe("14:00");
    expect(formatter("ar", "Europe/Amsterdam").date(d)).toContain("سبتمبر");
    expect(formatter("nl", "Europe/Amsterdam").money(5500, "EUR").replace(/\s/g, " ")).toBe("€ 55,00");
  });
});
