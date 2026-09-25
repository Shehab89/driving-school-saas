import { z } from "zod";
import { many, one, withPlatform, withTenant, type Tx } from "@/lib/db";
import { isValidTimezone } from "@/lib/time";
import { ValidationError } from "@/lib/errors";
import type { Principal } from "../principal";
import { audit } from "./audit";
import { inviteUser } from "./students";

export const createSchoolSchema = z.object({
  name: z.string().trim().min(2).max(120),
  slug: z.string().trim().toLowerCase().regex(/^[a-z0-9](?:[a-z0-9-]{1,61}[a-z0-9])$/),
  timezone: z.string().refine(isValidTimezone, "Unknown timezone"),
  currency: z.string().length(3).toUpperCase(),
  email: z.string().email().optional(),
  phone: z.string().max(40).optional(),
  address: z.string().max(300).optional(),
  ownerEmail: z.string().email(),
  ownerName: z.string().trim().min(1).max(100),
  planCode: z.string().default("starter"),
});

/** Sensible defaults so a one-person school can start the same day. */
const DEFAULT_LEVELS: Array<{ name: string; description: string; band: string | null; skills: string[] }> = [
  { name: "Level 1 – Car control", description: "Controls, moving off, stopping, steering", band: "beginner", skills: ["Cockpit drill & controls", "Moving off and stopping", "Steering control", "Clutch control / gears"] },
  { name: "Level 2 – Basic traffic", description: "Quiet roads, junctions, observation", band: "basic", skills: ["Mirrors & observation", "Junctions (left/right)", "Speed management", "Signals"] },
  { name: "Level 3 – Urban driving", description: "Roundabouts, lanes, pedestrians", band: "intermediate", skills: ["Roundabouts", "Lane discipline", "Pedestrian crossings", "Hazard perception"] },
  { name: "Level 4 – Advanced", description: "Motorways, manoeuvres, independent driving", band: "advanced", skills: ["Motorway driving", "Parallel parking", "Bay parking", "Independent driving"] },
  { name: "Level 5 – Exam ready", description: "Mock tests and polishing", band: null, skills: ["Mock test passed", "Night / adverse conditions"] },
];

export async function createSchool(raw: z.input<typeof createSchoolSchema>, createdBy: string | null) {
  const input = createSchoolSchema.parse(raw);
  // Creating a tenant is a platform operation; everything after the school row is written under that tenant's context.
  const school = await withPlatform(async (tx) => {
    const exists = await one(tx, `SELECT 1 FROM schools WHERE slug = $1`, [input.slug]);
    if (exists) throw new ValidationError("This school URL is already taken.");
    const s = (await one<{ id: string }>(
      tx,
      `INSERT INTO schools (slug, name, timezone, currency, email, phone, address, status) VALUES ($1,$2,$3,$4,$5,$6,$7,'trial') RETURNING id`,
      [input.slug, input.name, input.timezone, input.currency, input.email ?? null, input.phone ?? null, input.address ?? null],
    ))!;
    const plan = await one<{ id: string }>(tx, `SELECT id FROM plans WHERE code = $1`, [input.planCode]);
    if (plan) {
      await tx.query(
        `INSERT INTO school_subscriptions (school_id, plan_id, status, trial_ends_at) VALUES ($1,$2,'trialing', now() + interval '30 days')`,
        [s.id, plan.id],
      );
    }
    await tx.query(
      `INSERT INTO audit_logs (school_id, actor_type, actor_user_id, action, entity_type, entity_id) VALUES ($1,'user',$2,'school.created','school',$1)`,
      [s.id, createdBy],
    );
    return s;
  });

  await withTenant(school.id, async (tx) => {
    const p: Principal = { type: "system", schoolId: school.id };
    await tx.query(`INSERT INTO school_settings (school_id) VALUES ($1)`, [school.id]);
    for (const weekday of [1, 2, 3, 4, 5]) {
      await tx.query(`INSERT INTO school_opening_hours (school_id, weekday, opens_at, closes_at) VALUES ($1,$2,'08:00','19:00')`, [school.id, weekday]);
    }
    await tx.query(`INSERT INTO school_opening_hours (school_id, weekday, opens_at, closes_at) VALUES ($1,6,'09:00','15:00')`, [school.id]);
    await seedDefaultLevels(tx, school.id);
    await inviteUser(tx, p, { role: "school_owner", email: input.ownerEmail, notificationType: "user_invite", name: input.ownerName });
  });
  return school;
}

export async function seedDefaultLevels(tx: Tx, schoolId: string) {
  let pos = 1;
  for (const lvl of DEFAULT_LEVELS) {
    const l = (await one<{ id: string }>(
      tx,
      `INSERT INTO level_definitions (school_id, position, name, description, assessment_band) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
      [schoolId, pos++, lvl.name, lvl.description, lvl.band],
    ))!;
    let sp = 1;
    for (const skill of lvl.skills) {
      await tx.query(`INSERT INTO skills (school_id, level_id, position, name) VALUES ($1,$2,$3,$4)`, [schoolId, l.id, sp++, skill]);
    }
  }
}

/** SaaS admin overview. Uses the platform role on purpose. */
export async function platformOverview() {
  return withPlatform(async (tx) => {
    const schools = await many<{
      id: string;
      name: string;
      slug: string;
      status: string;
      created_at: Date;
      plan: string | null;
      subscription_status: string | null;
      students: number;
      instructors: number;
      lessons_30d: number;
      revenue_30d_cents: number;
      currency: string;
    }>(
      tx,
      `SELECT s.id, s.name, s.slug, s.status, s.created_at, s.currency, pl.name AS plan, sub.status AS subscription_status,
              (SELECT count(*)::int FROM students st WHERE st.school_id = s.id AND st.status IN ('active','lead')) AS students,
              (SELECT count(*)::int FROM instructors i WHERE i.school_id = s.id AND i.status = 'active') AS instructors,
              (SELECT count(*)::int FROM lessons l WHERE l.school_id = s.id AND l.status = 'completed' AND l.start_time > now() - interval '30 days') AS lessons_30d,
              (SELECT COALESCE(sum(amount_cents),0)::int FROM payments p WHERE p.school_id = s.id AND p.status = 'paid' AND p.paid_at > now() - interval '30 days') AS revenue_30d_cents
         FROM schools s
         LEFT JOIN school_subscriptions sub ON sub.school_id = s.id AND sub.status <> 'cancelled'
         LEFT JOIN plans pl ON pl.id = sub.plan_id
        ORDER BY s.created_at DESC`,
    );
    const totals = await one<{ schools: number; active_students: number; lessons_30d: number; whatsapp_msgs_30d: number }>(
      tx,
      `SELECT (SELECT count(*)::int FROM schools WHERE status IN ('trial','active')) AS schools,
              (SELECT count(*)::int FROM students WHERE status = 'active') AS active_students,
              (SELECT count(*)::int FROM lessons WHERE status = 'completed' AND start_time > now() - interval '30 days') AS lessons_30d,
              (SELECT count(*)::int FROM whatsapp_messages WHERE created_at > now() - interval '30 days') AS whatsapp_msgs_30d`,
    );
    const plans = await many<{ id: string; code: string; name: string; monthly_price_cents: number; currency: string }>(
      tx,
      `SELECT id, code, name, monthly_price_cents, currency FROM plans WHERE is_active ORDER BY monthly_price_cents`,
    );
    return { schools, totals: totals!, plans };
  });
}

export async function setSchoolStatus(schoolId: string, status: "trial" | "active" | "suspended" | "closed", actorUserId: string) {
  await withPlatform(async (tx) => {
    await tx.query(`UPDATE schools SET status = $2 WHERE id = $1`, [schoolId, status]);
    await tx.query(
      `INSERT INTO audit_logs (school_id, actor_type, actor_user_id, action, entity_type, entity_id, changes) VALUES ($1,'user',$2,'school.status_changed','school',$1,$3)`,
      [schoolId, actorUserId, JSON.stringify({ status })],
    );
  });
}

export async function setSchoolPlan(schoolId: string, planId: string, status: "trialing" | "active" | "past_due" | "cancelled", actorUserId: string) {
  await withPlatform(async (tx) => {
    await tx.query(`UPDATE school_subscriptions SET status = 'cancelled', cancelled_at = now() WHERE school_id = $1 AND status <> 'cancelled'`, [schoolId]);
    if (status !== "cancelled") {
      await tx.query(
        `INSERT INTO school_subscriptions (school_id, plan_id, status, current_period_start, current_period_end)
         VALUES ($1,$2,$3, now(), now() + interval '1 month')`,
        [schoolId, planId, status],
      );
    }
    await tx.query(
      `INSERT INTO audit_logs (school_id, actor_type, actor_user_id, action, entity_type, entity_id, changes) VALUES ($1,'user',$2,'subscription.changed','school',$1,$3)`,
      [schoolId, actorUserId, JSON.stringify({ planId, status })],
    );
  });
}

export async function updateSchoolProfileAndSettings(
  tx: Tx,
  p: Principal,
  input: { school: Partial<{ name: string; address: string; phone: string; email: string; timezone: string; currency: string }>; settings: Record<string, unknown> },
) {
  if (input.school.timezone && !isValidTimezone(input.school.timezone)) throw new ValidationError("Unknown timezone");
  const s = input.school;
  await tx.query(
    `UPDATE schools SET name = COALESCE($2,name), address = COALESCE($3,address), phone = COALESCE($4,phone),
            email = COALESCE($5,email), timezone = COALESCE($6,timezone), currency = COALESCE($7,currency)
      WHERE id = $1`,
    [p.schoolId, s.name ?? null, s.address ?? null, s.phone ?? null, s.email ?? null, s.timezone ?? null, s.currency ?? null],
  );
  const allowed = [
    "min_reschedule_notice_hours",
    "min_cancellation_notice_hours",
    "late_cancellation_fee_cents",
    "min_booking_lead_hours",
    "booking_horizon_days",
    "default_lesson_minutes",
    "default_lesson_price_cents",
    "slot_granularity_minutes",
    "buffer_minutes",
    "payment_due_days",
    "auto_payment_request",
    "reminder_hours_before",
    "reschedule_requires_approval",
    "ai_agent_enabled",
    "ai_agent_can_book",
    "school_info_for_agent",
  ];
  const entries = Object.entries(input.settings).filter(([k, v]) => allowed.includes(k) && v !== undefined);
  if (entries.length) {
    const sets = entries.map(([k], i) => `${k} = $${i + 2}`).join(", ");
    await tx.query(`UPDATE school_settings SET ${sets} WHERE school_id = $1`, [p.schoolId, ...entries.map(([, v]) => v)]);
  }
  await audit(tx, p, "school.settings_updated", "school", p.schoolId, { school: s, settings: Object.fromEntries(entries) });
}
