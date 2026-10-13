import { describe, expect, it } from "vitest";
import { toCsv } from "@/server/services/reports";

describe("toCsv", () => {
  it("quotes commas, quotes and newlines", () => {
    expect(toCsv(["a", "b"], [["x,y", 'say "hi"'], ["line\nbreak", null]])).toBe('a,b\r\n"x,y","say ""hi"""\r\n"line\nbreak",\r\n');
  });
  it("neutralises spreadsheet formulas in text cells but keeps negative numbers", () => {
    expect(toCsv(["v"], [["=HYPERLINK(\"x\")"], ["@SUM(A1)"], [-12.5]])).toBe("v\r\n\"'=HYPERLINK(\"\"x\"\")\"\r\n'@SUM(A1)\r\n-12.5\r\n");
  });
});
