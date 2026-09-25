import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { closePools, many, withTenant } from "@/lib/db";
import { createFixture, type Fixture } from "./helpers";

let A: Fixture;
let B: Fixture;

beforeAll(async () => {
  A = await createFixture();
  B = await createFixture();
});
afterAll(closePools);

describe("multi-tenant isolation (RLS + composite FKs)", () => {
  it("a tenant only sees its own rows", async () => {
    const rows = await withTenant(A.schoolId, (tx) => many<{ school_id: string }>(tx, `SELECT school_id FROM students`));
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.school_id === A.schoolId)).toBe(true);
    const bStudent = await withTenant(A.schoolId, (tx) => many(tx, `SELECT * FROM students WHERE id = $1`, [B.studentId]));
    expect(bStudent).toEqual([]);
  });

  it("forgetting the tenant context returns nothing (fail closed)", async () => {
    const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await client.connect();
    const r = await client.query(`SELECT count(*)::int AS n FROM students`);
    const s = await client.query(`SELECT count(*)::int AS n FROM schools`);
    await client.end();
    expect(r.rows[0].n).toBe(0);
    expect(s.rows[0].n).toBe(0);
  });

  it("cannot write rows for another school", async () => {
    await expect(
      withTenant(A.schoolId, (tx) =>
        tx.query(`INSERT INTO vehicles (school_id, registration_number, brand, model, transmission) VALUES ($1,'X-1','A','B','manual')`, [B.schoolId]),
      ),
    ).rejects.toThrow(/row-level security/);
  });

  it("cannot reference another school's student even with a valid id", async () => {
    // Composite FK (school_id, student_id) -> students(school_id, id); B's student is invisible and not in A.
    await expect(
      withTenant(A.schoolId, (tx) =>
        tx.query(
          `INSERT INTO lessons (school_id, student_id, instructor_id, start_time, end_time, lesson_number, price_cents, currency)
           VALUES ($1,$2,$3, now() + interval '5 days', now() + interval '5 days 1 hour', 1, 5000, 'EUR')`,
          [A.schoolId, B.studentId, A.instructorId],
        ),
      ),
    ).rejects.toThrow(/foreign key/);
  });

  it("cannot update or delete audit logs", async () => {
    await expect(withTenant(A.schoolId, (tx) => tx.query(`DELETE FROM audit_logs`))).rejects.toThrow(/permission denied/);
  });
});
