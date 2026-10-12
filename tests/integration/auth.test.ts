import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closePools, many, one, withPlatform, withTenant } from "@/lib/db";
import { hashPassword } from "@/lib/crypto";
import { changePassword, login, requestPasswordReset, resetPassword } from "@/server/services/auth";
import { changeUserRole, inviteAdmin, setUserStatus } from "@/server/services/team";
import { assertCanViewStudent, createStudent } from "@/server/services/students";
import { makeOwnerAnInstructor } from "@/server/services/staff";
import { asUser, createFixture, type Fixture } from "./helpers";

let f: Fixture;
let studentEmail: string;

async function setPassword(userId: string, pw: string) {
  await withPlatform(async (tx) => tx.query(`UPDATE users SET password_hash = $2 WHERE id = $1`, [userId, await hashPassword(pw)]));
}

/** The reset link from the queued e-mail (before the worker scrubs it). */
async function latestResetToken(userId: string): Promise<string | null> {
  const n = await withPlatform((tx) =>
    one<{ url: string }>(
      tx,
      `SELECT payload->>'reset_url' AS url FROM notifications WHERE recipient_user_id = $1 AND type = 'password_reset' ORDER BY created_at DESC LIMIT 1`,
      [userId],
    ),
  );
  return n?.url?.split("/reset/")[1] ?? null;
}

async function tokenVersion(userId: string) {
  return (await withPlatform((tx) => one<{ token_version: number }>(tx, `SELECT token_version FROM users WHERE id = $1`, [userId])))!.token_version;
}

beforeAll(async () => {
  f = await createFixture();
  studentEmail = (await withPlatform((tx) => one<{ email: string }>(tx, `SELECT email FROM users WHERE id = $1`, [f.studentActor.userId])))!.email;
  await setPassword(f.studentActor.userId, "original-password-1");
});
afterAll(closePools);

describe("account recovery", () => {
  it("does not reveal whether an e-mail exists", async () => {
    await expect(requestPasswordReset("nobody-here@example.com")).resolves.toBeUndefined();
    const n = await withPlatform((tx) => many(tx, `SELECT 1 FROM notifications WHERE to_address = 'nobody-here@example.com'`));
    expect(n).toEqual([]);
  });

  it("resets the password with a one-time link and revokes existing sessions", async () => {
    const before = await tokenVersion(f.studentActor.userId);
    await requestPasswordReset(studentEmail.toUpperCase());
    const token = await latestResetToken(f.studentActor.userId);
    expect(token).toBeTruthy();

    const user = await resetPassword(token!, "brand-new-password-2");
    expect(user.token_version).toBe(before + 1);
    expect((await login(studentEmail, "brand-new-password-2")).ok).toBe(true);
    expect((await login(studentEmail, "original-password-1")).ok).toBe(false);
    // Used once; a second use fails.
    await expect(resetPassword(token!, "another-password-3")).rejects.toThrow(/invalid or has expired/);
    // The account owner is told about the change.
    const changed = await withPlatform((tx) => many(tx, `SELECT 1 FROM notifications WHERE recipient_user_id = $1 AND type = 'password_changed'`, [f.studentActor.userId]));
    expect(changed.length).toBe(1);
  });

  it("a newer reset link supersedes the older one", async () => {
    await requestPasswordReset(studentEmail);
    const first = await latestResetToken(f.studentActor.userId);
    await requestPasswordReset(studentEmail);
    const second = await latestResetToken(f.studentActor.userId);
    expect(first).not.toBe(second);
    await expect(resetPassword(first!, "older-link-password")).rejects.toThrow(/invalid/);
    await expect(resetPassword(second!, "newer-link-password")).resolves.toBeTruthy();
  });

  it("expired links are refused", async () => {
    await requestPasswordReset(studentEmail);
    const token = await latestResetToken(f.studentActor.userId);
    await withPlatform((tx) => tx.query(`UPDATE user_invites SET expires_at = now() - interval '1 minute' WHERE user_id = $1 AND used_at IS NULL`, [f.studentActor.userId]));
    await expect(resetPassword(token!, "too-late-password")).rejects.toThrow(/expired/);
  });

  it("a reset link cannot be used to activate, nor reactivate a disabled account", async () => {
    await requestPasswordReset(studentEmail);
    const token = await latestResetToken(f.studentActor.userId);
    await withTenant(f.schoolId, (tx) => setUserStatus(tx, f.owner, f.studentActor.userId, "disabled"));
    await expect(resetPassword(token!, "sneaky-password-9")).rejects.toThrow(/invalid/);
    // A disabled account gets no reset e-mail at all.
    const countBefore = (await withPlatform((tx) => many(tx, `SELECT 1 FROM notifications WHERE recipient_user_id = $1 AND type = 'password_reset'`, [f.studentActor.userId]))).length;
    await requestPasswordReset(studentEmail);
    const countAfter = (await withPlatform((tx) => many(tx, `SELECT 1 FROM notifications WHERE recipient_user_id = $1 AND type = 'password_reset'`, [f.studentActor.userId]))).length;
    expect(countAfter).toBe(countBefore);
    expect((await login(studentEmail, "newer-link-password")).ok).toBe(false);
    await withTenant(f.schoolId, (tx) => setUserStatus(tx, f.owner, f.studentActor.userId, "active"));
    expect((await login(studentEmail, "newer-link-password")).ok).toBe(true);
  });

  it("changing the password needs the current one", async () => {
    await expect(changePassword(f.studentActor.userId, "wrong-current-pw", "whatever-password-1")).rejects.toThrow(/current password/);
    const before = await tokenVersion(f.studentActor.userId);
    await changePassword(f.studentActor.userId, "newer-link-password", "changed-password-4");
    expect(await tokenVersion(f.studentActor.userId)).toBe(before + 1);
    expect((await login(studentEmail, "changed-password-4")).ok).toBe(true);
  });
});

describe("permission changes", () => {
  it("only the owner manages staff; changes revoke sessions immediately", async () => {
    const { userId } = await withTenant(f.schoolId, (tx) => inviteAdmin(tx, f.owner, { email: "office@example.com", name: "Office" }));
    // An instructor cannot disable anyone.
    await expect(withTenant(f.schoolId, (tx) => setUserStatus(tx, asUser(f.instructorActor), userId, "disabled"))).rejects.toThrow(/not allowed/);
    // An office admin cannot change staff, but can deactivate a student login.
    await withTenant(f.schoolId, (tx) => tx.query(`UPDATE users SET status = 'active' WHERE id = $1`, [userId]));
    const adminActor = { userId, role: "school_admin" as const, schoolId: f.schoolId, email: "office@example.com", instructorId: null, studentId: null };
    await expect(withTenant(f.schoolId, (tx) => setUserStatus(tx, asUser(adminActor), f.instructorActor.userId, "disabled"))).rejects.toThrow(/not allowed/);
    await withTenant(f.schoolId, (tx) => setUserStatus(tx, asUser(adminActor), f.studentActor.userId, "disabled"));
    await withTenant(f.schoolId, (tx) => setUserStatus(tx, asUser(adminActor), f.studentActor.userId, "active"));

    const before = await tokenVersion(f.instructorActor.userId);
    await withTenant(f.schoolId, (tx) => changeUserRole(tx, f.owner, f.instructorActor.userId, "school_admin"));
    expect(await tokenVersion(f.instructorActor.userId)).toBe(before + 1);
    await withTenant(f.schoolId, (tx) => changeUserRole(tx, f.owner, f.instructorActor.userId, "instructor"));

    // An admin without an instructor profile cannot become instructor-only.
    await expect(withTenant(f.schoolId, (tx) => changeUserRole(tx, f.owner, userId, "instructor"))).rejects.toThrow(/no instructor profile/);
    // Nobody changes the owner or themselves here.
    await expect(withTenant(f.schoolId, (tx) => setUserStatus(tx, f.owner, f.ownerActor.userId, "disabled"))).rejects.toThrow(/your own account/);

    const audits = await withTenant(f.schoolId, (tx) => many<{ action: string }>(tx, `SELECT action FROM audit_logs WHERE action LIKE 'user.%'`));
    expect(audits.map((a) => a.action)).toEqual(expect.arrayContaining(["user.disabled", "user.enabled", "user.role_changed", "user.invited"]));
  });

  it("an instructor cannot open a student they do not teach", async () => {
    const other = await withTenant(f.schoolId, (tx) => createStudent(tx, f.owner, { firstName: "Not", lastName: "Mine", createLogin: false }));
    await expect(withTenant(f.schoolId, (tx) => assertCanViewStudent(tx, asUser(f.instructorActor), other.id))).rejects.toThrow(/not allowed/);
    // A second instructor (the owner, teaching) assigned as primary can.
    await withTenant(f.schoolId, (tx) => makeOwnerAnInstructor(tx, f.owner));
    await withTenant(f.schoolId, (tx) => tx.query(`UPDATE students SET primary_instructor_id = $2 WHERE id = $1`, [other.id, f.instructorId]));
    await expect(withTenant(f.schoolId, (tx) => assertCanViewStudent(tx, asUser(f.instructorActor), other.id))).resolves.toBeUndefined();
  });
});
