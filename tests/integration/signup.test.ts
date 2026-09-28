import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closePools, one, withPlatform, withTenant } from "@/lib/db";
import { acceptInvite, login } from "@/server/services/auth";
import { findSchoolForSignup, signUpStudent } from "@/server/services/signup";
import { createFixture, type Fixture } from "./helpers";

let f: Fixture;
let slug: string;
beforeAll(async () => {
  f = await createFixture();
  slug = (await withPlatform((tx) => one<{ slug: string }>(tx, `SELECT slug FROM schools WHERE id = $1`, [f.schoolId])))!.slug;
});
afterAll(closePools);

const answers = {
  has_driven_before: false,
  previous_lessons: "none" as const,
  approx_driving_hours: null,
  can_drive_manual: "unsure" as const,
  traffic_comfort: 3,
  has_foreign_license: false,
  wants_transmission: "manual" as const,
  notes: undefined,
};

describe("public self-signup (/join)", () => {
  it("offers the school by its slug, with the real default price, when self-booking is on", async () => {
    await withTenant(f.schoolId, (tx) => tx.query(`UPDATE school_settings SET student_self_booking = true, default_lesson_price_cents = 6000`));
    const r = await findSchoolForSignup(slug);
    expect(r).toMatchObject({ ok: true, school: { priceCents: 6000 } });
  });

  it("says the school isn't taking sign-ups when self-booking is off", async () => {
    await withTenant(f.schoolId, (tx) => tx.query(`UPDATE school_settings SET student_self_booking = false`));
    const r = await findSchoolForSignup(slug);
    expect(r).toEqual({ ok: false, reason: "not_accepting" });
    await withTenant(f.schoolId, (tx) => tx.query(`UPDATE school_settings SET student_self_booking = true`));
  });

  it("an unknown slug is reported as not found", async () => {
    const r = await findSchoolForSignup("no-such-school");
    expect(r).toEqual({ ok: false, reason: "not_found" });
  });

  it("signing up creates an active student and a web-form assessment with a suggested level, but the login isn't active yet", async () => {
    const before = await withTenant(f.schoolId, (tx) => tx.query(`SELECT count(*)::int AS n FROM students`));
    const { studentId, activationToken } = await withTenant(f.schoolId, (tx) =>
      signUpStudent(tx, f.schoolId, { firstName: "Lea", lastName: "Novak", email: "lea.novak@example.com", phone: "+31699000111", password: "correct horse battery", answers }),
    );
    expect(activationToken).toBeTruthy();

    const row = await withTenant(f.schoolId, (tx) =>
      one<{ status: string; source: string; current_level_id: string | null; level_confirmed: boolean; user_status: string }>(
        tx,
        `SELECT s.status, s.source, s.current_level_id, s.level_confirmed, u.status AS user_status
           FROM students s JOIN users u ON u.id = s.user_id WHERE s.id = $1`,
        [studentId],
      ),
    );
    // The account isn't activated until the caller applies the chosen password (see /join's action).
    expect(row).toMatchObject({ status: "active", source: "web", level_confirmed: false, user_status: "invited" });
    expect(row!.current_level_id).not.toBeNull(); // a beginner-band level was suggested

    const assessment = await withTenant(f.schoolId, (tx) =>
      one<{ source: string; status: string }>(tx, `SELECT source, status FROM assessments WHERE student_id = $1`, [studentId]),
    );
    expect(assessment).toEqual({ source: "web_form", status: "suggested" });

    const after = await withTenant(f.schoolId, (tx) => tx.query(`SELECT count(*)::int AS n FROM students`));
    expect(after.rows[0].n).toBe(before.rows[0].n + 1);

    // Activating with that token and the chosen password, as the /join page does, makes it a normal working login.
    const account = await acceptInvite(activationToken, "correct horse battery");
    expect(account.role).toBe("student");
    const loggedIn = await login("lea.novak@example.com", "correct horse battery");
    expect(loggedIn).toMatchObject({ ok: true, userId: account.id });
  });

  it("refuses a second sign-up with the same e-mail at the same school", async () => {
    await expect(
      withTenant(f.schoolId, (tx) => signUpStudent(tx, f.schoolId, { firstName: "Lea", lastName: "Novak", email: "lea.novak@example.com", phone: "+31699000111", password: "correct horse battery", answers })),
    ).rejects.toMatchObject({ code: "already_registered" });
  });
});
