/**
 * "Solo mode": a one-person school (the owner is the only instructor and
 * the only staff member). Most Dutch driving schools work like this, so the
 * owner gets one phone app ("My school") instead of an instructor app plus
 * a school portal. As soon as the school adds a second instructor or office
 * staff, the full portal comes back on its own; nothing has to be moved.
 */
import { one, withTenant, type Tx } from "@/lib/db";
import type { Role } from "@/lib/rbac";

export async function isSoloSchool(tx: Tx): Promise<boolean> {
  const r = await one<{ staff: number; instructors: number; owner_teaches: boolean }>(
    tx,
    `SELECT (SELECT count(*)::int FROM users WHERE role IN ('school_owner','school_admin','instructor') AND status <> 'disabled') AS staff,
            (SELECT count(*)::int FROM instructors WHERE status = 'active') AS instructors,
            EXISTS (SELECT 1 FROM instructors i JOIN users u ON u.id = i.user_id
                     WHERE u.role = 'school_owner' AND i.status = 'active') AS owner_teaches`,
  );
  return Boolean(r && r.staff === 1 && r.instructors === 1 && r.owner_teaches);
}

/** Whether this signed-in user should get the single "My school" app. */
export async function soloModeFor(actor: { role: Role; schoolId: string | null; instructorId: string | null }): Promise<boolean> {
  if (actor.role !== "school_owner" || !actor.schoolId || !actor.instructorId) return false;
  return withTenant(actor.schoolId, isSoloSchool);
}
