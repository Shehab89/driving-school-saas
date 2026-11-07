import { describe, expect, it } from "vitest";
import { buildRows, detectDelimiter, guessMapping, looksLikeHeader, parseTable, splitName, toIsoDate } from "@/lib/student-import";

describe("student import parsing", () => {
  it("detects tabs (pasted from Excel), semicolons (Dutch CSV) and commas", () => {
    expect(detectDelimiter("a\tb\tc")).toBe("\t");
    expect(detectDelimiter("naam;email;tel")).toBe(";");
    expect(detectDelimiter("name,email")).toBe(",");
  });

  it("reads quoted cells with delimiters, quotes and new lines", () => {
    expect(parseTable('naam;notitie\n"de Vries, Jan";"zegt ""hoi""\nen meer"\n\n', ";")).toEqual([
      ["naam", "notitie"],
      ["de Vries, Jan", 'zegt "hoi"\nen meer'],
    ]);
  });

  it("guesses columns in Dutch, English and Arabic", () => {
    expect(guessMapping(["Naam", "E-mailadres", "Mobiel", "Geboortedatum", "Lessen over", "Opmerkingen"])).toEqual(["fullName", "email", "phone", "dateOfBirth", "credits", "notes"]);
    expect(guessMapping(["First name", "Last name", "Email", "Phone", "Something else"])).toEqual(["firstName", "lastName", "email", "phone", ""]);
    expect(guessMapping(["الاسم الأول", "اسم العائلة", "الهاتف"])).toEqual(["firstName", "lastName", "phone"]);
  });

  it("tells a title row from a student row", () => {
    expect(looksLikeHeader(["Naam", "Email"])).toBe(true);
    expect(looksLikeHeader(["Jan de Vries", "jan@example.com"])).toBe(false);
  });

  it("understands Dutch dates and rejects impossible ones", () => {
    expect(toIsoDate("31-12-2006")).toBe("2006-12-31");
    expect(toIsoDate("1/2/2007")).toBe("2007-02-01");
    expect(toIsoDate("2007-02-01")).toBe("2007-02-01");
    expect(toIsoDate("31-02-2007")).toBeNull();
    expect(toIsoDate("")).toBe("");
  });

  it("splits a full name and flags bad rows", () => {
    expect(splitName("Jan de Vries")).toEqual(["Jan", "de Vries"]);
    const rows = buildRows([["Naam", "Email", "Tegoed"], ["Jan de Vries", "JAN@x.nl", "3"], ["", "a@b.nl", ""], ["Kim", "kim@x.nl", "2,5"]], ["fullName", "email", "credits"], true);
    expect(rows[0]).toMatchObject({ line: 2, firstName: "Jan", lastName: "de Vries", email: "jan@x.nl", credits: 3 });
    expect(rows[1]!.error).toBe("name_missing");
    expect(rows[2]!.error).toBe("credits_invalid");
  });
});
