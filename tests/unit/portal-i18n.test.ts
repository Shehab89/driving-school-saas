import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import nl from "@/i18n/portal-nl";
import ar from "@/i18n/portal-ar";
import { portalTranslator } from "@/i18n/portal";

const SRC = join(__dirname, "../../src");
const PATTERN = /\b(?:pt|ptKey|getPt\(\)\))\(\s*"((?:[^"\\]|\\.)*)"/g;

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return files(p);
    return /\.tsx?$/.test(name) && !p.endsWith(join("i18n", "portal.ts")) ? [p] : [];
  });
}

const used = new Set<string>();
for (const f of files(SRC)) for (const m of readFileSync(f, "utf8").matchAll(PATTERN)) used.add(JSON.parse(`"${m[1]}"`));

const placeholders = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

describe("school portal translations", () => {
  it("finds portal texts in the source", () => {
    expect(used.size).toBeGreaterThan(100);
  });
  for (const [lang, dict] of [["nl", nl], ["ar", ar]] as const) {
    it(`${lang} has every portal text, with the same placeholders`, () => {
      const missing = [...used].filter((k) => !(k in dict));
      expect(missing).toEqual([]);
      const wrong = [...used].filter((k) => k in dict && placeholders(dict[k] ?? "").join() !== placeholders(k).join());
      expect(wrong).toEqual([]);
    });
  }
  it("fills placeholders and falls back to English", () => {
    expect(portalTranslator("en")("Page {page}", { page: 2 })).toBe("Page 2");
    expect(portalTranslator("nl")("a text nobody translated")).toBe("a text nobody translated");
  });
});
