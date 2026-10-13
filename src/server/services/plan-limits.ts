import { one, type Tx } from "@/lib/db";
import { PolicyError } from "@/lib/errors";

/**
 * Enforce the school's subscription plan limits when adding instructors or
 * students. Schools without a live subscription are not limited here (the
 * platform admin manages that case explicitly).
 */
export async function assertPlanLimit(tx: Tx, schoolId: string, kind: "instructors" | "students") {
  const row = await one<{ limit: number | null; used: number; plan: string }>(
    tx,
    kind === "instructors"
      ? `SELECT pl.max_instructors AS limit, pl.name AS plan,
                (SELECT count(*)::int FROM instructors WHERE status = 'active') AS used
           FROM school_subscriptions sub JOIN plans pl ON pl.id = sub.plan_id
          WHERE sub.school_id = $1 AND sub.status <> 'cancelled'`
      : `SELECT pl.max_active_students AS limit, pl.name AS plan,
                (SELECT count(*)::int FROM students WHERE status IN ('active','lead')) AS used
           FROM school_subscriptions sub JOIN plans pl ON pl.id = sub.plan_id
          WHERE sub.school_id = $1 AND sub.status <> 'cancelled'`,
    [schoolId],
  );
  if (row?.limit != null && row.used >= row.limit) {
    throw new PolicyError(
      `Your ${row.plan} plan allows ${row.limit} ${kind === "instructors" ? "active instructors" : "active students"}. Archive one or ask us to upgrade your plan.`,
      "plan_limit_reached",
      { limit: row.limit, kind },
    );
  }
}
