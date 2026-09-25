import type { Tx } from "@/lib/db";
import { actorUserId, type Principal } from "../principal";

export async function audit(
  tx: Tx,
  p: Principal,
  action: string,
  entityType: string,
  entityId: string | null,
  changes?: Record<string, unknown>,
) {
  await tx.query(
    `INSERT INTO audit_logs (school_id, actor_type, actor_user_id, action, entity_type, entity_id, changes)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [p.schoolId, p.type, actorUserId(p), action, entityType, entityId, changes ? JSON.stringify(changes) : null],
  );
}
