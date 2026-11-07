/**
 * Bring students over from a previous app, Excel or paper: one call, one
 * transaction. Students already in DriveDesk (same e-mail) are skipped, so
 * running the same file twice does not create doubles. Lessons left from a
 * previous system become a credit adjustment, so the balance carries over.
 */
import { one, type Tx } from "@/lib/db";
import { ForbiddenError, ValidationError } from "@/lib/errors";
import { can } from "@/lib/rbac";
import { buildRows, MAX_IMPORT_ROWS, type ImportRow, type Mapping } from "@/lib/student-import";
import type { Principal } from "../principal";
import { audit } from "./audit";
import { adjustCredits } from "./billing";
import { createStudent } from "./students";

export interface ImportResult {
  created: number;
  skippedExisting: number;
  invalid: ImportRow[];
  creditsAdded: number;
}

export async function importStudents(
  tx: Tx,
  p: Principal,
  input: { table: string[][]; mapping: Mapping; hasHeader: boolean; sendInvites: boolean },
): Promise<ImportResult> {
  if (p.type !== "user" || !can(p.actor.role, "students:write")) throw new ForbiddenError();
  if (!input.mapping.some((m) => m === "firstName" || m === "fullName")) throw new ValidationError("Choose which column holds the name.");
  const rows = buildRows(input.table, input.mapping, input.hasHeader);
  if (rows.length === 0) throw new ValidationError("There are no students in this list.");
  if (input.table.length - (input.hasHeader ? 1 : 0) > MAX_IMPORT_ROWS) throw new ValidationError(`Import at most ${MAX_IMPORT_ROWS} students at a time.`);
  const canCredit = can(p.actor.role, "payments:record_manual");
  const result: ImportResult = { created: 0, skippedExisting: 0, invalid: [], creditsAdded: 0 };
  const seen = new Set<string>();
  for (const r of rows) {
    if (r.error) { result.invalid.push(r); continue; }
    if (r.email) {
      const exists = seen.has(r.email) || (await one(tx, `SELECT 1 FROM students WHERE lower(email) = $1`, [r.email]));
      if (exists) { result.skippedExisting++; continue; }
      seen.add(r.email);
    }
    const s = await createStudent(tx, p, {
      firstName: r.firstName,
      lastName: r.lastName,
      email: r.email || undefined,
      phone: r.phone || undefined,
      dateOfBirth: r.dateOfBirth || undefined,
      notes: r.notes || undefined,
      source: "import",
      createLogin: input.sendInvites && Boolean(r.email),
    });
    result.created++;
    if (r.credits > 0 && canCredit) {
      await adjustCredits(tx, p, s.id, r.credits, "Lessons left in previous system (import)");
      result.creditsAdded += r.credits;
    }
  }
  await audit(tx, p, "students.imported", "school", p.schoolId, { created: result.created, skipped: result.skippedExisting, invalid: result.invalid.length, credits: result.creditsAdded });
  return result;
}
