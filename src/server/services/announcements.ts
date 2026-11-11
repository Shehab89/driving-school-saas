/**
 * One message to many students at once, for example "We are closed today
 * because of the snow". It goes out through the normal notification outbox,
 * on each student's own channel (e-mail, or WhatsApp when they chose it).
 */
import { z } from "zod";
import { many, one, type Tx } from "@/lib/db";
import { ForbiddenError, PolicyError } from "@/lib/errors";
import { can } from "@/lib/rbac";
import type { Principal } from "../principal";
import { audit } from "./audit";
import { enqueueNotification } from "./notifications";

/** A school can send at most this many announcements per 24 hours (protects students and the school's sender reputation). */
export const MAX_ANNOUNCEMENTS_PER_DAY = 5;

export const AUDIENCES = ["all", "upcoming", "instructor"] as const;
export type Audience = (typeof AUDIENCES)[number];

const schema = z.object({
  audience: z.enum(AUDIENCES),
  instructorId: z.string().uuid().nullish(),
  days: z.coerce.number().int().min(1).max(30).default(2),
  subject: z.string().trim().min(1).max(120),
  body: z.string().trim().min(1).max(2000),
});
export type AnnouncementInput = z.input<typeof schema>;

interface Recipient {
  id: string;
  first_name: string;
  email: string | null;
}

/** Active students in the chosen group. "upcoming" = a lesson in the next `days` days. */
function audienceQuery(a: { audience: Audience; instructorId?: string | null; days: number }): { where: string; params: unknown[] } {
  if (a.audience === "upcoming") {
    return {
      where: `EXISTS (SELECT 1 FROM lessons l WHERE l.student_id = s.id AND l.status IN ('scheduled','confirmed')
                AND l.start_time >= now() AND l.start_time < now() + make_interval(days => $1))`,
      params: [a.days],
    };
  }
  if (a.audience === "instructor") {
    return {
      where: `(s.primary_instructor_id = $1 OR EXISTS (SELECT 1 FROM lessons l WHERE l.student_id = s.id AND l.instructor_id = $1
                AND l.status IN ('scheduled','confirmed') AND l.start_time >= now()))`,
      params: [a.instructorId ?? null],
    };
  }
  return { where: "true", params: [] };
}

async function recipients(tx: Tx, a: { audience: Audience; instructorId?: string | null; days: number }): Promise<Recipient[]> {
  const q = audienceQuery(a);
  return many<Recipient>(tx, `SELECT s.id, s.first_name, s.email FROM students s WHERE s.status = 'active' AND ${q.where} ORDER BY s.id LIMIT 5000`, q.params);
}

/** How many students each group has right now (shown next to the choices). */
export async function audienceCounts(tx: Tx, days = 2, instructorId: string | null = null) {
  const count = async (audience: Audience) => {
    const q = audienceQuery({ audience, instructorId, days });
    return (await one<{ n: number }>(tx, `SELECT count(*)::int AS n FROM students s WHERE s.status = 'active' AND ${q.where}`, q.params))!.n;
  };
  return { all: await count("all"), upcoming: await count("upcoming"), instructor: instructorId ? await count("instructor") : 0 };
}

function assertMaySend(p: Principal) {
  if (p.type !== "user" || !can(p.actor.role, "students:write")) throw new ForbiddenError();
}

export async function sendAnnouncement(tx: Tx, p: Principal, raw: AnnouncementInput): Promise<{ id: string; recipients: number }> {
  assertMaySend(p);
  const a = schema.parse(raw);
  if (a.audience === "instructor" && !a.instructorId) throw new PolicyError("Choose an instructor.", "announcement_instructor");
  // Serialise per school so two quick clicks cannot both pass the daily limit.
  await tx.query(`SELECT pg_advisory_xact_lock(hashtext('announcement:' || current_setting('app.school_id')))`);
  const today = (await one<{ n: number }>(tx, `SELECT count(*)::int AS n FROM announcements WHERE created_at > now() - interval '24 hours'`))!.n;
  if (today >= MAX_ANNOUNCEMENTS_PER_DAY) throw new PolicyError("Daily limit reached.", "announcement_limit", { max: MAX_ANNOUNCEMENTS_PER_DAY });
  const to = await recipients(tx, a);
  if (to.length === 0) throw new PolicyError("No students in this group.", "announcement_empty");
  const row = await one<{ id: string }>(
    tx,
    `INSERT INTO announcements (school_id, audience, instructor_id, days, subject, body, recipients, created_by)
     VALUES (current_setting('app.school_id')::uuid, $1, $2, $3, $4, $5, $6, $7) RETURNING id`,
    [a.audience, a.audience === "instructor" ? a.instructorId : null, a.audience === "upcoming" ? a.days : null, a.subject, a.body, to.length, p.type === "user" ? p.actor.userId : null],
  );
  for (const s of to) {
    await enqueueNotification(tx, {
      schoolId: p.schoolId,
      type: "announcement",
      to: s.email,
      studentId: s.id,
      payload: { name: s.first_name, subject: a.subject, body: a.body },
      dedupeKey: `announcement:${row!.id}:${s.id}`,
    });
  }
  await audit(tx, p, "announcement.sent", "announcement", row!.id, { audience: a.audience, recipients: to.length });
  return { id: row!.id, recipients: to.length };
}

export async function recentAnnouncements(tx: Tx, limit = 10) {
  return many<{ id: string; subject: string; body: string; audience: Audience; recipients: number; created_at: Date; sent: number; failed: number }>(
    tx,
    `SELECT a.id, a.subject, a.body, a.audience, a.recipients, a.created_at,
            (SELECT count(*)::int FROM notifications n WHERE n.dedupe_key LIKE 'announcement:' || a.id || ':%' AND n.status = 'sent') AS sent,
            (SELECT count(*)::int FROM notifications n WHERE n.dedupe_key LIKE 'announcement:' || a.id || ':%' AND n.status = 'failed') AS failed
       FROM announcements a ORDER BY a.created_at DESC LIMIT $1`,
    [limit],
  );
}
