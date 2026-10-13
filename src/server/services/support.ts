/**
 * Support access. Platform admins see aggregates by default; personal and
 * operational detail of a school is only visible while the school's owner has
 * an active, time-boxed grant. Each view is written to the school's audit log.
 */
import { z } from "zod";
import { many, one, withPlatform, type Tx } from "@/lib/db";
import { ForbiddenError, NotFoundError, ValidationError } from "@/lib/errors";
import { can } from "@/lib/rbac";
import type { Principal } from "../principal";
import { audit } from "./audit";
import { randomToken, sha256Hex } from "@/lib/crypto";
import { env } from "@/lib/env";
import { requestPasswordReset } from "./auth";
import { enqueueNotification } from "./notifications";

const grantSchema = z.object({
  hours: z.coerce.number().int().refine((h) => [1, 24, 72].includes(h), "Choose 1, 24 or 72 hours"),
  reason: z.string().trim().min(3).max(500),
});

export async function grantSupportAccess(tx: Tx, p: Principal, raw: z.input<typeof grantSchema>) {
  if (p.type !== "user" || !can(p.actor.role, "school:manage_settings")) throw new ForbiddenError();
  const g = grantSchema.parse(raw);
  const row = (await one<{ id: string }>(
    tx,
    `INSERT INTO support_access_grants (school_id, granted_by, reason, expires_at) VALUES ($1,$2,$3, now() + make_interval(hours => $4)) RETURNING id`,
    [p.schoolId, p.actor.userId, g.reason, g.hours],
  ))!;
  await audit(tx, p, "support.access_granted", "support_access_grant", row.id, { hours: g.hours, reason: g.reason });
  return row;
}

export async function revokeSupportAccess(tx: Tx, p: Principal, grantId: string) {
  if (p.type !== "user" || !can(p.actor.role, "school:manage_settings")) throw new ForbiddenError();
  const r = await tx.query(`UPDATE support_access_grants SET revoked_at = now(), revoked_by = $2 WHERE id = $1 AND revoked_at IS NULL`, [grantId, p.actor.userId]);
  if (r.rowCount) await audit(tx, p, "support.access_revoked", "support_access_grant", grantId);
}

/** For the school's settings page: grants and the support views made under them. */
export async function supportAccessHistory(tx: Tx) {
  return {
    grants: await many<{ id: string; reason: string; expires_at: Date; revoked_at: Date | null; created_at: Date; active: boolean }>(
      tx,
      `SELECT id, reason, expires_at, revoked_at, created_at, (revoked_at IS NULL AND expires_at > now()) AS active
         FROM support_access_grants ORDER BY created_at DESC LIMIT 10`,
    ),
    views: await many<{ created_at: Date; action: string }>(
      tx,
      `SELECT created_at, action FROM audit_logs WHERE action LIKE 'support.%' AND actor_type = 'user' AND action NOT LIKE 'support.access_%' ORDER BY created_at DESC LIMIT 20`,
    ),
  };
}

async function activeGrant(tx: Tx, schoolId: string) {
  return one<{ id: string; expires_at: Date; reason: string }>(
    tx,
    `SELECT id, expires_at, reason FROM support_access_grants WHERE school_id = $1 AND revoked_at IS NULL AND expires_at > now() ORDER BY expires_at DESC LIMIT 1`,
    [schoolId],
  );
}

async function platformAudit(tx: Tx, schoolId: string | null, adminUserId: string, action: string, changes?: Record<string, unknown>) {
  await tx.query(
    `INSERT INTO audit_logs (school_id, actor_type, actor_user_id, action, entity_type, entity_id, changes) VALUES ($1,'user',$2,$3,'school',$1,$4)`,
    [schoolId, adminUserId, action, changes ? JSON.stringify(changes) : null],
  );
}

/** School detail for the platform console. Aggregates always; detail only under an active grant. */
export async function platformSchoolDetail(schoolId: string, adminUserId: string) {
  return withPlatform(async (tx) => {
    const school = await one<{ id: string; name: string; slug: string; status: string; timezone: string; currency: string; created_at: Date; email: string | null; phone: string | null }>(
      tx,
      `SELECT id, name, slug, status, timezone, currency, created_at, email, phone FROM schools WHERE id = $1`,
      [schoolId],
    );
    if (!school) throw new NotFoundError("School");
    const usage = (await one<{ students: number; instructors: number; vehicles: number; lessons_30d: number; upcoming: number; failed_notifications_7d: number; whatsapp_handoffs: number; max_instructors: number | null; max_active_students: number | null; plan: string | null; sub_status: string | null; trial_ends_at: Date | null }>(
      tx,
      `SELECT (SELECT count(*)::int FROM students WHERE school_id = $1 AND status IN ('active','lead')) AS students,
              (SELECT count(*)::int FROM instructors WHERE school_id = $1 AND status = 'active') AS instructors,
              (SELECT count(*)::int FROM vehicles WHERE school_id = $1 AND status <> 'retired') AS vehicles,
              (SELECT count(*)::int FROM lessons WHERE school_id = $1 AND status = 'completed' AND start_time > now() - interval '30 days') AS lessons_30d,
              (SELECT count(*)::int FROM lessons WHERE school_id = $1 AND status IN ('scheduled','confirmed') AND start_time > now()) AS upcoming,
              (SELECT count(*)::int FROM notifications WHERE school_id = $1 AND status = 'failed' AND created_at > now() - interval '7 days') AS failed_notifications_7d,
              (SELECT count(*)::int FROM whatsapp_conversations WHERE school_id = $1 AND status = 'handoff') AS whatsapp_handoffs,
              pl.max_instructors, pl.max_active_students, pl.name AS plan, sub.status AS sub_status, sub.trial_ends_at
         FROM (SELECT 1) x
         LEFT JOIN school_subscriptions sub ON sub.school_id = $1 AND sub.status <> 'cancelled'
         LEFT JOIN plans pl ON pl.id = sub.plan_id`,
      [schoolId],
    ))!;
    // The owner is the platform's business contact, so their sign-in state is always visible.
    const owners = await many<{ id: string; email: string; status: string; last_login_at: Date | null }>(
      tx,
      `SELECT id, email, status, last_login_at FROM users WHERE school_id = $1 AND role = 'school_owner'`,
      [schoolId],
    );
    const grant = await activeGrant(tx, schoolId);
    let support: null | {
      team: Array<{ email: string; role: string; status: string; last_login_at: Date | null }>;
      auditTrail: Array<{ created_at: Date; action: string; entity_type: string; actor_type: string }>;
      failedNotifications: Array<{ created_at: Date; type: string; last_error: string | null; attempts: number }>;
      settings: Record<string, unknown> | null;
    } = null;
    if (grant) {
      support = {
        team: await many(tx, `SELECT email, role, status, last_login_at FROM users WHERE school_id = $1 AND role <> 'student' ORDER BY role, email`, [schoolId]),
        auditTrail: await many(tx, `SELECT created_at, action, entity_type, actor_type FROM audit_logs WHERE school_id = $1 ORDER BY created_at DESC LIMIT 50`, [schoolId]),
        failedNotifications: await many(
          tx,
          `SELECT created_at, type, last_error, attempts FROM notifications WHERE school_id = $1 AND status = 'failed' ORDER BY created_at DESC LIMIT 20`,
          [schoolId],
        ),
        settings: await one(tx, `SELECT * FROM school_settings WHERE school_id = $1`, [schoolId]),
      };
      await platformAudit(tx, schoolId, adminUserId, "support.viewed", { grant_id: grant.id });
    }
    return { school, usage, owners, grant, support };
  });
}

/**
 * Support workflow for a locked-out owner: an active owner gets a password
 * reset link, an owner who never activated gets a fresh invitation. Either
 * way the link goes only to the owner's own address.
 */
export async function sendOwnerAccessLink(schoolId: string, adminUserId: string): Promise<"reset" | "invite"> {
  const owner = await withPlatform(async (tx) => {
    const o = await one<{ id: string; email: string; slug: string; status: string }>(
      tx,
      `SELECT u.id, u.email, s.slug, u.status FROM users u JOIN schools s ON s.id = u.school_id
        WHERE u.school_id = $1 AND u.role = 'school_owner' AND u.status IN ('active','invited') ORDER BY u.status LIMIT 1`,
      [schoolId],
    );
    if (!o) throw new ValidationError("This school has no owner account that can be recovered.");
    if (o.status === "invited") {
      await tx.query(`UPDATE user_invites SET used_at = now() WHERE user_id = $1 AND purpose = 'activate' AND used_at IS NULL`, [o.id]);
      const token = randomToken();
      await tx.query(
        `INSERT INTO user_invites (school_id, user_id, token_hash, purpose, expires_at) VALUES ($1,$2,$3,'activate', now() + interval '7 days')`,
        [schoolId, o.id, sha256Hex(token)],
      );
      await enqueueNotification(tx, {
        schoolId,
        type: "user_invite",
        to: o.email,
        userId: o.id,
        payload: { name: o.email.split("@")[0], role: "school_owner", activation_url: `${env.appUrl}/activate/${token}` },
      });
    }
    await platformAudit(tx, schoolId, adminUserId, o.status === "invited" ? "support.owner_invite_resent" : "support.owner_reset_sent");
    return o;
  });
  if (owner.status === "active") {
    await requestPasswordReset(owner.email, owner.slug);
    return "reset";
  }
  return "invite";
}

/** Actions taken by platform admins, across schools. */
export async function platformAuditLog(limit = 200) {
  return withPlatform((tx) =>
    many<{ created_at: Date; action: string; admin_email: string | null; school_name: string | null; changes: unknown }>(
      tx,
      `SELECT a.created_at, a.action, u.email AS admin_email, s.name AS school_name, a.changes
         FROM audit_logs a
         JOIN users u ON u.id = a.actor_user_id AND u.role = 'saas_admin'
         LEFT JOIN schools s ON s.id = a.school_id
        ORDER BY a.created_at DESC LIMIT $1`,
      [limit],
    ),
  );
}
