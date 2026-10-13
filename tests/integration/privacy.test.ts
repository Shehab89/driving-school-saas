import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closePools, many, one, withPlatform, withTenant } from "@/lib/db";
import { recordManualPayment } from "@/server/services/billing";
import { getInvoiceForViewer } from "@/server/services/invoices";
import { bookLesson, cancelLesson } from "@/server/services/lessons";
import { createPackage, purchasePackage } from "@/server/services/packages";
import { applyRetention, eraseStudent, exportStudentData } from "@/server/services/privacy";
import { createStudent } from "@/server/services/students";
import { asUser, createFixture, slotAt, type Fixture } from "./helpers";

let f: Fixture;
let pkgId: string;

async function newStudent(name: string) {
  return withTenant(f.schoolId, (tx) =>
    createStudent(tx, f.owner, { firstName: name, lastName: "Tester", email: `${name.toLowerCase()}-${Date.now()}@example.com`, phone: `+3162${String(Math.floor(Math.random() * 1e7)).padStart(7, "0")}` }),
  );
}

/** A paid package invoice, so the student has financial records that must survive erasure. */
async function paidInvoice(studentId: string) {
  return withTenant(f.schoolId, async (tx) => {
    const r = await purchasePackage(tx, f.owner, { studentId, packageId: pkgId });
    await recordManualPayment(tx, f.owner, r.paymentId, "cash");
    return (await one<{ invoice_id: string }>(tx, `SELECT invoice_id FROM payments WHERE id = $1`, [r.paymentId]))!.invoice_id;
  });
}

beforeAll(async () => {
  f = await createFixture();
  pkgId = (await withTenant(f.schoolId, (tx) => createPackage(tx, f.owner, { name: "Five", lessonCount: 5, priceCents: 30000 }))).id;
});
afterAll(closePools);

describe("data export", () => {
  it("gives the student everything held about them, and records the export", async () => {
    await paidInvoice(f.studentId);
    const data = await withTenant(f.schoolId, (tx) => exportStudentData(tx, asUser(f.studentActor), f.studentId));
    expect(data.student.id).toBe(f.studentId);
    expect(data.invoices.length).toBeGreaterThan(0);
    expect(data.payments.length).toBeGreaterThan(0);
    expect(data).toHaveProperty("whatsapp");
    const logged = await withTenant(f.schoolId, (tx) => many(tx, `SELECT 1 FROM audit_logs WHERE action = 'student.data_exported' AND entity_id = $1`, [f.studentId]));
    expect(logged.length).toBe(1);
  });

  it("refuses another student's data and instructors", async () => {
    const other = await newStudent("Other");
    await expect(withTenant(f.schoolId, (tx) => exportStudentData(tx, asUser(f.studentActor), other.id))).rejects.toThrow(/not allowed/i);
    await expect(withTenant(f.schoolId, (tx) => exportStudentData(tx, asUser(f.instructorActor), other.id))).rejects.toThrow(/not allowed/i);
  });
});

describe("erasure", () => {
  it("only the owner may erase, with a reason", async () => {
    const s = await newStudent("Nora");
    await expect(withTenant(f.schoolId, (tx) => eraseStudent(tx, asUser(f.instructorActor), s.id, "x"))).rejects.toThrow(/not allowed/i);
    await expect(withTenant(f.schoolId, (tx) => eraseStudent(tx, f.owner, s.id, " "))).rejects.toThrow(/reason/i);
  });

  it("is refused while lessons are planned or money is open", async () => {
    const s = await newStudent("Pim");
    const lesson = await withTenant(f.schoolId, (tx) => bookLesson(tx, f.owner, { studentId: s.id, slot: slotAt(f, 20, 9), bookedVia: "staff" }));
    await expect(withTenant(f.schoolId, (tx) => eraseStudent(tx, f.owner, s.id, "request"))).rejects.toThrow(/planned lesson/);
    await withTenant(f.schoolId, (tx) => cancelLesson(tx, f.owner, lesson.id, "student left"));
    await withTenant(f.schoolId, (tx) => purchasePackage(tx, f.owner, { studentId: s.id, packageId: pkgId }));
    await expect(withTenant(f.schoolId, (tx) => eraseStudent(tx, f.owner, s.id, "request"))).rejects.toThrow(/open payment/);
  });

  it("removes personal data, keeps the books, and blanks audit details", async () => {
    const s = await newStudent("Fenna");
    const invoiceId = await paidInvoice(s.id);
    await withPlatform((tx) =>
      tx.query(`INSERT INTO whatsapp_conversations (school_id, wa_phone_e164, student_id) VALUES ($1, (SELECT phone_e164 FROM students WHERE id = $2), $2)`, [f.schoolId, s.id]),
    );
    const userId = (await withPlatform((tx) => one<{ user_id: string }>(tx, `SELECT user_id FROM students WHERE id = $1`, [s.id])))!.user_id;

    await withTenant(f.schoolId, (tx) => eraseStudent(tx, f.owner, s.id, "Request by the student"));

    const row = await withPlatform((tx) => one<Record<string, unknown>>(tx, `SELECT first_name, last_name, email, phone, phone_e164, status, erased_at FROM students WHERE id = $1`, [s.id]));
    expect(row).toMatchObject({ first_name: "Erased", email: null, phone: null, phone_e164: null, status: "archived" });
    expect(row!.erased_at).not.toBeNull();
    expect(userId).toBeTruthy();
    const u = await withPlatform((tx) => one<{ email: string; status: string; password_hash: string | null }>(tx, `SELECT email, status, password_hash FROM users WHERE id = $1`, [userId]));
    expect(u).toMatchObject({ status: "disabled", password_hash: null });
    expect(u!.email).toMatch(/@invalid\.example$/);
    const convs = await withPlatform((tx) => many(tx, `SELECT 1 FROM whatsapp_conversations WHERE student_id = $1`, [s.id]));
    expect(convs).toEqual([]);
    // The invoice still says who was billed (tax retention), and its amounts are unchanged.
    const inv = await withTenant(f.schoolId, (tx) => getInvoiceForViewer(tx, f.ownerActor, invoiceId));
    expect(inv.student.name).toBe("Fenna Tester");
    expect(inv.total_cents).toBe(30000);
    // Earlier audit entries about the student no longer carry their details; the erasure itself is logged.
    const logs = await withTenant(f.schoolId, (tx) => many<{ action: string; changes: Record<string, unknown> }>(tx, `SELECT action, changes FROM audit_logs WHERE entity_id = $1 ORDER BY id`, [s.id]));
    expect(logs.filter((l) => l.action !== "student.erased").every((l) => l.changes.erased === true)).toBe(true);
    expect(logs.at(-1)).toMatchObject({ action: "student.erased", changes: { reason: "Request by the student" } });
  });

  it("the application still cannot edit the audit log directly", async () => {
    await expect(withTenant(f.schoolId, (tx) => tx.query(`UPDATE audit_logs SET changes = '{}' WHERE school_id = $1`, [f.schoolId]))).rejects.toThrow(/permission denied/);
  });
});

describe("retention", () => {
  it("erases students archived longer than the school's period, and not others", async () => {
    const old = await newStudent("Oud");
    const recent = await newStudent("Nieuw");
    await withPlatform(async (tx) => {
      await tx.query(`UPDATE students SET status = 'archived' WHERE id = ANY($1)`, [[old.id, recent.id]]);
      await tx.query(`UPDATE students SET archived_at = now() - interval '25 months' WHERE id = $1`, [old.id]);
    });
    await applyRetention();
    const rows = await withPlatform((tx) => many<{ id: string; erased_at: Date | null }>(tx, `SELECT id, erased_at FROM students WHERE id = ANY($1)`, [[old.id, recent.id]]));
    expect(rows.find((r) => r.id === old.id)!.erased_at).not.toBeNull();
    expect(rows.find((r) => r.id === recent.id)!.erased_at).toBeNull();
  });

  it("does nothing when the school switched automatic erasure off", async () => {
    const s = await newStudent("Blijf");
    await withPlatform(async (tx) => {
      await tx.query(`UPDATE school_settings SET retention_months = NULL WHERE school_id = $1`, [f.schoolId]);
      await tx.query(`UPDATE students SET status = 'archived' WHERE id = $1`, [s.id]);
      await tx.query(`UPDATE students SET archived_at = now() - interval '10 years' WHERE id = $1`, [s.id]);
    });
    await applyRetention();
    const r = await withPlatform((tx) => one<{ erased_at: Date | null }>(tx, `SELECT erased_at FROM students WHERE id = $1`, [s.id]));
    expect(r!.erased_at).toBeNull();
  });
});
