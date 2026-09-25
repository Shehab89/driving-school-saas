import { many, one, withPlatform } from "@/lib/db";
import { hashPassword, sha256Hex, verifyPassword } from "@/lib/crypto";
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
      `SELECT id, user_id FROM user_invites WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now() FOR UPDATE`,
      [sha256Hex(token)],
    );
    if (!invite) throw new ValidationError("This link is invalid or has expired.");
    await tx.query(`UPDATE user_invites SET used_at = now() WHERE id = $1`, [invite.id]);
    const user = (await one<{ id: string; school_id: string | null; role: Role; token_version: number }>(
      tx,
      `UPDATE users SET password_hash = $2, status = 'active', token_version = token_version + 1 WHERE id = $1
       RETURNING id, school_id, role, token_version`,
      [invite.user_id, hash],
    ))!;
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
