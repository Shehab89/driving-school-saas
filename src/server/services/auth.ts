import { many, one, withPlatform, type Tx } from "@/lib/db";
import { hashPassword, randomToken, sha256Hex, verifyPassword } from "@/lib/crypto";
import { env } from "@/lib/env";
import { enqueueNotification } from "./notifications";
import { ValidationError } from "@/lib/errors";
import type { Role } from "@/lib/rbac";

interface LoginRow {
  id: string;
  school_id: string | null;
  role: Role;
  status: string;
  password_hash: string | null;
  token_version: number;
  locale: string | null;
  school_slug: string | null;
  school_status: string | null;
}

// Hash of a random password; used to keep timing similar when the user doesn't exist.
const DUMMY_HASH = "scrypt$16384$8$1$AAAAAAAAAAAAAAAAAAAAAA==$" + Buffer.alloc(64).toString("base64");

export type LoginResult =
  | { ok: true; userId: string; schoolId: string | null; role: Role; tokenVersion: number; locale: string | null }
  | { ok: false; reason: "invalid" | "choose_school"; schools?: string[] };

/**
 * Login is inherently cross-tenant (we don't know the school yet), so it uses
 * the platform role, but only ever reads the matching user row(s).
 */
export async function login(email: string, password: string, schoolSlug?: string): Promise<LoginResult> {
  const rows = await withPlatform((tx) =>
    many<LoginRow>(
      tx,
      `SELECT u.id, u.school_id, u.role, u.status, u.password_hash, u.token_version, u.locale, s.slug AS school_slug, s.status AS school_status
         FROM users u LEFT JOIN schools s ON s.id = u.school_id
        WHERE u.email = $1 AND ($2::text IS NULL OR s.slug = $2 OR u.school_id IS NULL)`,
      [email.trim(), schoolSlug?.trim() || null],
    ),
  );
  const candidates = rows.filter((r) => r.status === "active" && (r.school_id === null || ["trial", "active"].includes(r.school_status ?? "")));
  if (candidates.length > 1) {
    return { ok: false, reason: "choose_school", schools: candidates.map((c) => c.school_slug ?? "platform") };
  }
  const user = candidates[0];
  const valid = await verifyPassword(password, user?.password_hash ?? DUMMY_HASH);
  if (!user || !valid) return { ok: false, reason: "invalid" };
  await withPlatform((tx) => tx.query(`UPDATE users SET last_login_at = now() WHERE id = $1`, [user.id]));
  return { ok: true, userId: user.id, schoolId: user.school_id, role: user.role, tokenVersion: user.token_version, locale: user.locale };
}

/** Accept an activation / reset link and set the password. */
export async function acceptInvite(token: string, password: string) {
  const hash = await hashPassword(password).catch((e: Error) => {
    throw new ValidationError(e.message);
  });
  return withPlatform(async (tx) => {
    const invite = await one<{ id: string; user_id: string }>(
      tx,
      `SELECT id, user_id FROM user_invites WHERE token_hash = $1 AND purpose = 'activate' AND used_at IS NULL AND expires_at > now() FOR UPDATE`,
      [sha256Hex(token)],
    );
    if (!invite) throw new ValidationError("This link is invalid or has expired.");
    await tx.query(`UPDATE user_invites SET used_at = now() WHERE id = $1`, [invite.id]);
    const user = (await one<{ id: string; school_id: string | null; role: Role; token_version: number }>(
      tx,
      `UPDATE users SET password_hash = $2, status = 'active', token_version = token_version + 1 WHERE id = $1 AND status = 'invited'
       RETURNING id, school_id, role, token_version`,
      [invite.user_id, hash],
    ));
    // An activation link never re-enables an account that was disabled after the invite.
    if (!user) throw new ValidationError("This link is invalid or has expired.");
    await tx.query(
      `INSERT INTO audit_logs (school_id, actor_type, actor_user_id, action, entity_type, entity_id) VALUES ($1,'user',$2,'user.activated','user',$2)`,
      [user.school_id, user.id],
    );
    return user;
  });
}

/** Remember a signed-in user's language (used to restore it at the next login). */
export async function saveUserLocale(userId: string, schoolId: string | null, locale: string) {
  await withPlatform((tx) => tx.query(`UPDATE users SET locale = $3 WHERE id = $1 AND school_id IS NOT DISTINCT FROM $2`, [userId, schoolId, locale]));
}

const RESET_TTL = "1 hour";

/**
 * Self-service password recovery. Always behaves the same whether or not the
 * e-mail exists (no account enumeration). A reset link is single-use, valid for
 * one hour, and supersedes any earlier unused reset links.
 */
export async function requestPasswordReset(email: string, schoolSlug?: string): Promise<void> {
  const addr = email.trim().toLowerCase();
  if (!addr) return;
  await withPlatform(async (tx) => {
    const users = await many<{ id: string; school_id: string | null; school_slug: string | null }>(
      tx,
      `SELECT u.id, u.school_id, s.slug AS school_slug
         FROM users u LEFT JOIN schools s ON s.id = u.school_id
        WHERE u.email = $1 AND u.status = 'active'
          AND (u.school_id IS NULL OR s.status IN ('trial','active'))
          AND ($2::text IS NULL OR s.slug = $2 OR u.school_id IS NULL)`,
      [addr, schoolSlug?.trim() || null],
    );
    for (const u of users) {
      await tx.query(`UPDATE user_invites SET used_at = now() WHERE user_id = $1 AND purpose = 'password_reset' AND used_at IS NULL`, [u.id]);
      const token = randomToken();
      await tx.query(
        `INSERT INTO user_invites (school_id, user_id, token_hash, purpose, expires_at) VALUES ($1,$2,$3,'password_reset', now() + interval '${RESET_TTL}')`,
        [u.school_id, u.id, sha256Hex(token)],
      );
      await enqueueNotification(tx, {
        schoolId: u.school_id,
        type: "password_reset",
        to: addr,
        userId: u.id,
        // reset_url is a secret: the notification worker scrubs it after sending.
        payload: { reset_url: `${env.appUrl}/reset/${token}`, school_slug: u.school_slug },
      });
      await tx.query(
        `INSERT INTO audit_logs (school_id, actor_type, actor_user_id, action, entity_type, entity_id) VALUES ($1,'user',$2,'user.password_reset_requested','user',$2)`,
        [u.school_id, u.id],
      );
    }
  });
}

/**
 * Complete a reset: only for active accounts (a reset link never re-enables a
 * disabled user), and every existing session is revoked by bumping token_version.
 */
export async function resetPassword(token: string, password: string) {
  const hash = await hashPassword(password).catch((e: Error) => {
    throw new ValidationError(e.message);
  });
  return withPlatform(async (tx) => {
    const invite = await one<{ id: string; user_id: string }>(
      tx,
      `SELECT i.id, i.user_id FROM user_invites i JOIN users u ON u.id = i.user_id
        WHERE i.token_hash = $1 AND i.purpose = 'password_reset' AND i.used_at IS NULL AND i.expires_at > now() AND u.status = 'active'
        FOR UPDATE OF i`,
      [sha256Hex(token)],
    );
    if (!invite) throw new ValidationError("This link is invalid or has expired.");
    await tx.query(`UPDATE user_invites SET used_at = now() WHERE id = $1`, [invite.id]);
    const user = (await one<{ id: string; school_id: string | null; role: Role; token_version: number; email: string }>(
      tx,
      `UPDATE users SET password_hash = $2, token_version = token_version + 1 WHERE id = $1
       RETURNING id, school_id, role, token_version, email`,
      [invite.user_id, hash],
    ))!;
    await afterPasswordChange(tx, user);
    return user;
  });
}

/** Signed-in password change; requires the current password and revokes other sessions. */
export async function changePassword(userId: string, currentPassword: string, newPassword: string) {
  const hash = await hashPassword(newPassword).catch((e: Error) => {
    throw new ValidationError(e.message);
  });
  return withPlatform(async (tx) => {
    const row = await one<{ password_hash: string | null }>(tx, `SELECT password_hash FROM users WHERE id = $1 AND status = 'active' FOR UPDATE`, [userId]);
    if (!row || !(await verifyPassword(currentPassword, row.password_hash))) throw new ValidationError("Your current password is not correct.");
    const user = (await one<{ id: string; school_id: string | null; role: Role; token_version: number; email: string }>(
      tx,
      `UPDATE users SET password_hash = $2, token_version = token_version + 1 WHERE id = $1 RETURNING id, school_id, role, token_version, email`,
      [userId, hash],
    ))!;
    await afterPasswordChange(tx, user);
    return user;
  });
}

async function afterPasswordChange(tx: Tx, user: { id: string; school_id: string | null; email: string }) {
  await tx.query(`UPDATE user_invites SET used_at = now() WHERE user_id = $1 AND purpose = 'password_reset' AND used_at IS NULL`, [user.id]);
  await tx.query(
    `INSERT INTO audit_logs (school_id, actor_type, actor_user_id, action, entity_type, entity_id) VALUES ($1,'user',$2,'user.password_changed','user',$2)`,
    [user.school_id, user.id],
  );
  // Tell the account owner, so an unexpected change is noticed.
  await enqueueNotification(tx, { schoolId: user.school_id, type: "password_changed", to: user.email, userId: user.id, payload: {} });
}

/** Whether an activation or reset link can still be used, so a used or expired link says so before anyone types a password. */
export async function linkIsUsable(token: string, purpose: "activate" | "password_reset"): Promise<boolean> {
  const row = await withPlatform((tx) =>
    one(tx, `SELECT 1 FROM user_invites WHERE token_hash = $1 AND purpose = $2 AND used_at IS NULL AND expires_at > now()`, [sha256Hex(token), purpose]),
  );
  return !!row;
}
