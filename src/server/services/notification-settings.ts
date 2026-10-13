/** School-level notification settings: e-mail wording, WhatsApp templates, and the delivery log. */
import { z } from "zod";
import { many, type Tx } from "@/lib/db";
import { ForbiddenError, NotFoundError, ValidationError } from "@/lib/errors";
import { can } from "@/lib/rbac";
import type { Principal } from "../principal";
import { OVERRIDABLE_TYPES } from "../email/templates";
import { audit } from "./audit";
import type { NotificationType } from "./notifications";
import { WHATSAPP_TEMPLATE_PARAMS } from "./notification-prefs";

function requireOwner(p: Principal) {
  if (p.type !== "user" || !can(p.actor.role, "school:manage_settings")) throw new ForbiddenError();
  return p;
}

/** Empty subject and intro remove the override (back to the standard wording). */
export async function saveTemplateOverride(tx: Tx, p: Principal, type: string, subject: string, intro: string) {
  const u = requireOwner(p);
  if (!OVERRIDABLE_TYPES.includes(type as NotificationType)) throw new ValidationError("This message cannot be reworded.");
  const s = subject.trim() || null;
  const i = intro.trim() || null;
  if (s && s.length > 200) throw new ValidationError("Subject is too long (max 200 characters).");
  if (i && i.length > 1000) throw new ValidationError("Opening text is too long (max 1000 characters).");
  if (!s && !i) {
    await tx.query(`DELETE FROM notification_template_overrides WHERE type = $1`, [type]);
  } else {
    await tx.query(
      `INSERT INTO notification_template_overrides (school_id, type, subject, intro, updated_by) VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (school_id, type) DO UPDATE SET subject = EXCLUDED.subject, intro = EXCLUDED.intro, updated_by = EXCLUDED.updated_by, updated_at = now()`,
      [u.schoolId, type, s, i, u.actor.userId],
    );
  }
  await audit(tx, p, "notifications.wording_changed", "school", u.schoolId, { type, subject: s, intro: i });
}

const templateName = z.string().trim().regex(/^[a-z0-9_]{1,512}$/, "Template names use lowercase letters, digits and _ only");
const language = z.string().trim().regex(/^[a-z]{2,3}(_[A-Z]{2})?$/, "Language codes look like nl or en_US");

/** Map notification types to the school's Meta-approved WhatsApp templates. Empty name = not sent on WhatsApp. */
export async function saveWhatsAppTemplates(tx: Tx, p: Principal, raw: Record<string, { name: string; language: string }>) {
  requireOwner(p);
  const templates: Record<string, { name: string; language: string }> = {};
  for (const [type, v] of Object.entries(raw)) {
    if (!(type in WHATSAPP_TEMPLATE_PARAMS)) throw new ValidationError(`Unknown message type ${type}`);
    if (!v.name.trim()) continue;
    templates[type] = { name: templateName.parse(v.name), language: language.parse(v.language || "nl") };
  }
  const r = await tx.query(`UPDATE whatsapp_accounts SET templates = $1`, [JSON.stringify(templates)]);
  if (!r.rowCount) throw new NotFoundError("WhatsApp account");
  await audit(tx, p, "notifications.whatsapp_templates_changed", "school", p.schoolId, templates);
}

export interface NotificationLogRow {
  id: string;
  type: string;
  channel: string;
  to_address: string;
  status: string;
  delivery_status: string | null;
  attempts: number;
  last_error: string | null;
  created_at: Date;
  sent_at: Date | null;
}

export async function recentNotifications(tx: Tx, filter: "all" | "problems", limit = 100) {
  return many<NotificationLogRow>(
    tx,
    `SELECT id, type, channel, to_address, status, delivery_status, attempts, last_error, created_at, sent_at
       FROM notifications
      WHERE $1 = 'all' OR status IN ('failed','suppressed') OR delivery_status IN ('bounced','complained','failed')
      ORDER BY created_at DESC LIMIT $2`,
    [filter, limit],
  );
}
