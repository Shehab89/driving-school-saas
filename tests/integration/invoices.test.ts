import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closePools, one, withPlatform, withTenant } from "@/lib/db";
import { resolvePayLink } from "@/server/payments/checkout";
import { createPackage, purchasePackage } from "@/server/services/packages";
import { getInvoiceForViewer } from "@/server/services/invoices";
import { createStudent } from "@/server/services/students";
import { createFixture, type Fixture } from "./helpers";

let f: Fixture;
let invoiceId: string;

beforeAll(async () => {
  f = await createFixture();
  invoiceId = await withTenant(f.schoolId, async (tx) => {
    const pkg = await createPackage(tx, f.owner, { name: "Ten", lessonCount: 10, priceCents: 60500 });
    await purchasePackage(tx, f.owner, { studentId: f.studentId, packageId: pkg.id });
    const r = await tx.query<{ id: string }>(`SELECT invoice_id AS id FROM package_purchases WHERE student_id = $1`, [f.studentId]);
    return r.rows[0]!.id;
  });
});
afterAll(closePools);

describe("printable invoices", () => {
  it("shows staff the Dutch invoice fields with the VAT split", async () => {
    const inv = await withTenant(f.schoolId, (tx) => getInvoiceForViewer(tx, f.ownerActor, invoiceId));
    expect(inv.total_cents).toBe(60500);
    expect(inv.vat_rate_bps).toBe(2100);
    expect(inv.subtotal_cents + inv.tax_cents).toBe(60500);
    expect(inv.tax_cents).toBe(10500);
    expect(inv.items).toHaveLength(1);
    expect(inv.payment?.status).toBe("pending");
  });

  it("lets the student see their own invoice", async () => {
    const inv = await withTenant(f.schoolId, (tx) => getInvoiceForViewer(tx, f.studentActor, invoiceId));
    expect(inv.student.id).toBe(f.studentId);
  });

  it("hides it from other students and from instructors", async () => {
    const other = await withTenant(f.schoolId, (tx) => createStudent(tx, f.owner, { firstName: "Other", lastName: "S", email: `other-${Date.now()}@example.com` }));
    const otherActor = { ...f.studentActor, userId: f.studentActor.userId, studentId: other.id };
    await expect(withTenant(f.schoolId, (tx) => getInvoiceForViewer(tx, otherActor, invoiceId))).rejects.toThrow(/not found/i);
    await expect(withTenant(f.schoolId, (tx) => getInvoiceForViewer(tx, f.instructorActor, invoiceId))).rejects.toThrow(/not found/i);
  });

  it("is invisible from another school (RLS)", async () => {
    const g = await createFixture();
    await expect(withTenant(g.schoolId, (tx) => getInvoiceForViewer(tx, g.ownerActor, invoiceId))).rejects.toThrow(/not found/i);
  });
});

describe("pay link without a working payment provider", () => {
  it("shows a bank-transfer fallback and never marks anything paid", async () => {
    const pay = (await withPlatform((tx) => one<{ id: string; pay_token: string }>(tx, `SELECT id, pay_token FROM payments WHERE invoice_id = $1`, [invoiceId])))!;
    // A provider this deployment has no keys/integration for.
    await withPlatform((tx) => tx.query(`UPDATE payments SET provider = 'mollie' WHERE id = $1`, [pay.id]));
    await withPlatform((tx) => tx.query(`UPDATE school_settings SET iban = 'NL91ABNA0417164300' WHERE school_id = $1`, [f.schoolId]));
    const r = await resolvePayLink(pay.pay_token);
    expect(r).toMatchObject({ kind: "unavailable", iban: "NL91ABNA0417164300" });
    const after = await withPlatform((tx) => one<{ status: string; payment_link: string | null }>(tx, `SELECT status, payment_link FROM payments WHERE id = $1`, [pay.id]));
    expect(after).toEqual({ status: "pending", payment_link: null });
  });
});
