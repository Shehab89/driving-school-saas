/**
 * Read a student list copied from Excel / Google Sheets (tab separated) or
 * saved as CSV (comma or semicolon, the Dutch Excel default), and guess which
 * column is which from the header row. Pure functions: easy to test, no I/O.
 */

export const IMPORT_FIELDS = ["firstName", "lastName", "fullName", "email", "phone", "dateOfBirth", "credits", "notes"] as const;
export type ImportField = (typeof IMPORT_FIELDS)[number];
export type Mapping = Array<ImportField | "">;

export interface ImportRow {
  line: number;
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  dateOfBirth: string;
  credits: number;
  notes: string;
  error?: "name_missing" | "email_invalid" | "date_invalid" | "credits_invalid";
}

export const MAX_IMPORT_ROWS = 500;

/** Header words (EN / NL / AR and common exports) per field. Compared lower-case without spaces, dots, dashes or underscores. */
const SYNONYMS: Record<ImportField, string[]> = {
  firstName: ["firstname", "first", "givenname", "voornaam", "roepnaam", "الاسمالأول", "الاسم"],
  lastName: ["lastname", "surname", "familyname", "achternaam", "naamachternaam", "tussenvoegselachternaam", "اسمالعائلة", "العائلة", "الكنية"],
  fullName: ["name", "fullname", "naam", "volledigenaam", "leerling", "student", "leerlingnaam", "الاسمالكامل"],
  email: ["email", "emailadres", "mail", "emailaddress", "البريد", "البريدالإلكتروني", "ايميل", "إيميل"],
  phone: ["phone", "telephone", "mobile", "mobiel", "telefoon", "telefoonnummer", "tel", "gsm", "06", "whatsapp", "الهاتف", "الجوال", "رقمالهاتف", "موبايل"],
  dateOfBirth: ["dateofbirth", "birthdate", "dob", "birthday", "geboortedatum", "geboren", "تاريخالميلاد"],
  credits: ["credits", "lessonsleft", "lessenover", "tegoed", "lessentegoed", "resterendelessen", "saldo", "رصيد", "الدروسالمتبقية"],
  notes: ["notes", "note", "opmerking", "opmerkingen", "notities", "ملاحظات", "ملاحظة"],
};

const norm = (s: string) => s.toLowerCase().replace(/[\s._\-:]/g, "");

export function detectDelimiter(text: string): "\t" | ";" | "," {
  const first = text.split(/\r?\n/).find((l) => l.trim()) ?? "";
  const count = (c: string) => first.split(c).length - 1;
  if (count("\t") > 0) return "\t";
  return count(";") > count(",") ? ";" : ",";
}

/** RFC 4180-style parsing (quoted cells may hold the delimiter, quotes and newlines). */
export function parseTable(text: string, delimiter = detectDelimiter(text)): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  const src = text.replace(/^﻿/, "");
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]!;
    if (quoted) {
      if (ch === '"' && src[i + 1] === '"') { cell += '"'; i++; }
      else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"' && cell === "") quoted = true;
    else if (ch === delimiter) { row.push(cell.trim()); cell = ""; }
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && src[i + 1] === "\n") i++;
      row.push(cell.trim()); cell = "";
      if (row.some((c) => c !== "")) rows.push(row);
      row = [];
    } else cell += ch;
  }
  row.push(cell.trim());
  if (row.some((c) => c !== "")) rows.push(row);
  return rows;
}

/** Guess the field of each column from the header row; "" = ignore the column. */
export function guessMapping(header: string[]): Mapping {
  const used = new Set<ImportField>();
  return header.map((h) => {
    const n = norm(h);
    if (!n) return "";
    for (const f of IMPORT_FIELDS) {
      if (!used.has(f) && SYNONYMS[f].some((s) => n === s || (s.length > 3 && n.includes(s)))) {
        used.add(f);
        return f;
      }
    }
    return "";
  });
}

/** True when the first row looks like column titles rather than a student. */
export function looksLikeHeader(row: string[]): boolean {
  return guessMapping(row).filter(Boolean).length >= 1 && !row.some((c) => /@/.test(c) || /^\+?\d[\d\s-]{6,}$/.test(c));
}

/** dd-mm-yyyy, dd/mm/yyyy, d-m-yyyy (Dutch) or yyyy-mm-dd → yyyy-mm-dd; "" when empty; null when not a date. */
export function toIsoDate(v: string): string | null {
  const s = v.trim();
  if (!s) return "";
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s);
  let y: number, mo: number, d: number;
  if (m) { y = +m[1]!; mo = +m[2]!; d = +m[3]!; }
  else {
    m = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/.exec(s);
    if (!m) return null;
    d = +m[1]!; mo = +m[2]!; y = +m[3]!;
  }
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return null;
  return `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

/** Split "Jan de Vries" into first name "Jan" and last name "de Vries". */
export function splitName(full: string): [string, string] {
  const parts = full.trim().split(/\s+/);
  return [parts[0] ?? "", parts.slice(1).join(" ")];
}

export function buildRows(table: string[][], mapping: Mapping, hasHeader: boolean): ImportRow[] {
  const body = hasHeader ? table.slice(1) : table;
  const col = (r: string[], f: ImportField) => {
    const i = mapping.indexOf(f);
    return i >= 0 ? (r[i] ?? "").trim() : "";
  };
  return body.slice(0, MAX_IMPORT_ROWS).map((r, i) => {
    let firstName = col(r, "firstName");
    let lastName = col(r, "lastName");
    const full = col(r, "fullName");
    if (full && !firstName) [firstName, lastName] = lastName ? [full, lastName] : splitName(full);
    const email = col(r, "email").toLowerCase();
    const dob = toIsoDate(col(r, "dateOfBirth"));
    const rawCredits = col(r, "credits");
    const credits = rawCredits === "" ? 0 : Number(rawCredits.replace(",", "."));
    const row: ImportRow = {
      line: i + (hasHeader ? 2 : 1),
      firstName,
      lastName,
      email,
      phone: col(r, "phone"),
      dateOfBirth: dob ?? "",
      credits: Number.isInteger(credits) ? credits : 0,
      notes: col(r, "notes"),
    };
    if (!firstName) row.error = "name_missing";
    else if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) row.error = "email_invalid";
    else if (dob === null) row.error = "date_invalid";
    else if (!Number.isInteger(credits) || credits < 0 || credits > 200) row.error = "credits_invalid";
    return row;
  });
}
