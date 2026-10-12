import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closePools, many, one, withPlatform, withTenant } from "@/lib/db";
import { createSchool } from "@/server/services/schools";
import { createInstructor } from "@/server/services/staff";
import { grantSupportAccess, platformAuditLog, platformSchoolDetail, revokeSupportAccess, sendOwnerAccessLink, supportAccessHistory } from "@/server/services/support";
import type { Principal } from "@/server/principal";
import { asUser, createFixture, type Fixture } from "./helpers";

let f: Fixture;
let adminId: string;

beforeAll(async () => {
  f = await createFixture();
  adminId = (await withPlatform((tx) =>
    one<{ id: string }>(tx, `INSERT INTO users (role, email, status) VALUES ('saas_admin', $1, 'active') RETURNING id`, [`admin-${Date.now()}@platform.test`]),
  ))!.id;
});
afterAll(closePools);

describe("platform support access", () => {
  it("without a grant, platform admins see aggregates only and nothing is logged as viewed", async () => {
    const d = await platformSchoolDetail(f.schoolId, adminId);
    expect(d.support).toBeNull();
    expect(d.usage.students).toBeGreaterThan(0);
    const views = await withTenant(f.schoolId, (tx) => many(tx, `SELECT 1 FROM audit_logs WHERE action = 'support.viewed'`));
    expect(views).toEqual([]);
  });

  it("only the owner can grant; grants are time-boxed to at most 3 days", async () => {
    await expect(withTenant(f.schoolId, (tx) => grantSupportAccess(tx, asUser(f.instructorActor), { hours: 1, reason: "help" }))).rejects.toThrow(/not allowed/);
    await expect(withTenant(f.schoolId, (tx) => grantSupportAccess(tx, f.owner, { hours: 500, reason: "help" }))).rejects.toThrow();
  });

  it("with a grant, support sees detail and each view is visible to the school", async () => {
    const g = await withTenant(f.schoolId, (tx) => grantSupportAccess(tx, f.owner, { hours: 1, reason: "reminders not sent" }));
    const d = await platformSchoolDetail(f.schoolId, adminId);
    expect(d.support).not.toBeNull();
    expect(d.support!.team.length).toBeGreaterThan(0);
    // Students' personal data is not part of the support view.
    expect(d.support!.team.every((m) => m.role !== "student")).toBe(true);
    const h = await withTenant(f.schoolId, (tx) => supportAccessHistory(tx));
    expect(h.views.map((v) => v.action)).toContain("support.viewed");
    expect(h.grants[0]).toMatchObject({ active: true });

    await withTenant(f.schoolId, (tx) => revokeSupportAccess(tx, f.owner, g.id));
    expect((await platformSchoolDetail(f.schoolId, adminId)).support).toBeNull();
  });

  it("expired grants give no access", async () => {
    await withTenant(f.schoolId, (tx) => grantSupportAccess(tx, f.owner, { hours: 1, reason: "expiry test" }));
    await withPlatform((tx) =>
      tx.query(`UPDATE support_access_grants SET created_at = now() - interval '3 hours', expires_at = now() - interval '1 hour' WHERE school_id = $1 AND revoked_at IS NULL`, [f.schoolId]),
    );
    expect((await platformSchoolDetail(f.schoolId, adminId)).support).toBeNull();
  });

  it("a locked-out owner gets a recovery link at their own address, and it is audited", async () => {
    const kind = await sendOwnerAccessLink(f.schoolId, adminId);
    expect(kind).toBe("reset");
    const n = await withPlatform((tx) => one<{ to_address: string }>(
      tx, `SELECT to_address FROM notifications WHERE recipient_user_id = $1 AND type = 'password_reset' ORDER BY created_at DESC LIMIT 1`, [f.ownerActor.userId],
    ));
    expect(n!.to_address).toBe(f.ownerActor.email);
    const log = await platformAuditLog();
    expect(log.some((r) => r.action === "support.owner_reset_sent")).toBe(true);
  });
});

describe("plan limits", () => {
  it("a Starter school cannot add a second active instructor", async () => {
    const school = await createSchool({ name: "Tiny", slug: `tiny-${Date.now()}`, timezone: "Europe/Amsterdam", currency: "EUR", ownerEmail: `o-${Date.now()}@tiny.test`, ownerName: "O", planCode: "starter" }, null);
    const owner = await withTenant(school.id, (tx) => one<{ id: string; email: string }>(tx, `SELECT id, email FROM users WHERE role = 'school_owner'`));
    const p: Principal = { type: "user", schoolId: school.id, actor: { userId: owner!.id, role: "school_owner", schoolId: school.id, email: owner!.email, instructorId: null, studentId: null } };
    await withTenant(school.id, (tx) => createInstructor(tx, p, { firstName: "One", lastName: "I", email: "one@tiny.test" }));
    await expect(withTenant(school.id, (tx) => createInstructor(tx, p, { firstName: "Two", lastName: "I", email: "two@tiny.test" }))).rejects.toThrow(/plan allows 1/);
    // Never-activated owner: support re-sends the invitation instead of a reset.
    expect(await sendOwnerAccessLink(school.id, adminId)).toBe("invite");
  });
});
