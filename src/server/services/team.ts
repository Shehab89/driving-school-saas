/**
 * School team management: who can sign in, and with which role.
 * Every change bumps users.token_version, so the person's open sessions end
 * immediately and the new role or status applies on their next sign-in.
 */
import { z } from "zod";
import { many, one, type Tx } from "@/lib/db";
import { ForbiddenError, NotFoundError, ValidationError } from "@/lib/errors";
import { can, type Role } from "@/lib/rbac";
import type { Principal } from "../principal";
import { audit } from "./audit";
import { inviteUser } from "./students";

export interface TeamMember {
  id: string;
  email: string;
  role: Role;
  status: string;
  last_login_at: string | null;
  instructor_id: string | null;
  name: string | null;
}

function requireOwner(p: Principal) {
  if (p.type !== "user" || !can(p.actor.role, "team:manage")) throw new ForbiddenError();
  return p.actor;
}

export async function listTeam(tx: Tx): Promise<TeamMember[]> {
  return many<TeamMember>(
    tx,
    `SELECT u.id, u.email, u.role, u.status, u.last_login_at, i.id AS instructor_id,
            NULLIF(trim(coalesce(i.first_name,'') || ' ' || coalesce(i.last_name,'')), '') AS name
       FROM users u LEFT JOIN instructors i ON i.user_id = u.id
      WHERE u.role IN ('school_owner','school_admin','instructor')
      ORDER BY CASE u.role WHEN 'school_owner' THEN 0 WHEN 'school_admin' THEN 1 ELSE 2 END, u.email`,
  );
}

const inviteSchema = z.object({ email: z.string().trim().toLowerCase().email(), name: z.string().trim().min(1).max(100) });

/** Invite an office administrator (manages students, lessons and payments, not settings or the team). */
export async function inviteAdmin(tx: Tx, p: Principal, raw: z.input<typeof inviteSchema>) {
  requireOwner(p);
  const i = inviteSchema.parse(raw);
  const { userId } = await inviteUser(tx, p, { role: "school_admin", email: i.email, notificationType: "user_invite", name: i.name });
  await audit(tx, p, "user.invited", "user", userId, { role: "school_admin" });
  return { userId };
}

async function loadTarget(tx: Tx, p: Principal, userId: string) {
  if (p.type !== "user") throw new ForbiddenError();
  const actor = p.actor;
  const target = await one<{ id: string; role: Role; status: string; password_hash: string | null }>(
    tx,
    `SELECT id, role, status, password_hash FROM users WHERE id = $1 FOR UPDATE`,
    [userId],
  );
  if (!target) throw new NotFoundError("User");
  // Student logins can be managed by office staff; staff logins only by the owner.
  if (!can(actor.role, target.role === "student" ? "students:write" : "team:manage")) throw new ForbiddenError();
  if (target.id === actor.userId) throw new ValidationError("You cannot change your own account here.");
  if (target.role === "school_owner") throw new ForbiddenError("The owner account can only be changed by platform support.");
  return target;
}

/**
 * Disable or re-enable a sign-in. Works for staff and students (student
 * deactivation). Disabling never deletes data; lessons and invoices stay.
 */
export async function setUserStatus(tx: Tx, p: Principal, userId: string, status: "active" | "disabled") {
  const target = await loadTarget(tx, p, userId);
  if (target.status === status) return;
  // Re-enabling an account that never set a password puts it back to 'invited'.
  const next = status === "active" && !target.password_hash ? "invited" : status;
  await tx.query(`UPDATE users SET status = $2, token_version = token_version + 1 WHERE id = $1`, [userId, next]);
  if (status === "disabled") {
    // Outstanding activation/reset links must not work for a disabled account.
    await tx.query(`UPDATE user_invites SET used_at = now() WHERE user_id = $1 AND used_at IS NULL`, [userId]);
  }
  await audit(tx, p, status === "disabled" ? "user.disabled" : "user.enabled", "user", userId, { from: target.status, to: next });
}

/** Switch a staff member between office administrator and instructor. */
export async function changeUserRole(tx: Tx, p: Principal, userId: string, role: "school_admin" | "instructor") {
  requireOwner(p);
  const target = await loadTarget(tx, p, userId);
  if (!["school_admin", "instructor"].includes(target.role)) throw new ValidationError("Only staff roles can be changed.");
  if (target.role === role) return;
  if (role === "instructor") {
    const profile = await one(tx, `SELECT 1 FROM instructors WHERE user_id = $1`, [userId]);
    if (!profile) throw new ValidationError("This person has no instructor profile. Add them as an instructor first.");
  }
  await tx.query(`UPDATE users SET role = $2, token_version = token_version + 1 WHERE id = $1`, [userId, role]);
  await audit(tx, p, "user.role_changed", "user", userId, { from: target.role, to: role });
}
