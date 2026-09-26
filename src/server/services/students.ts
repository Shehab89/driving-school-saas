import { z } from "zod";
import { many, one, sequential, type Tx } from "@/lib/db";
import { env } from "@/lib/env";
import { randomToken, sha256Hex } from "@/lib/crypto";
import { ForbiddenError, NotFoundError, ValidationError } from "@/lib/errors";
import { can } from "@/lib/rbac";
import type { Principal } from "../principal";
import { checkStudentReschedule } from "../policies";
import { dbNow, loadSchoolContext } from "../scheduling/loader";
import { audit } from "./audit";
import { nextStudentNumber } from "./billing";
import { enqueueNotification } from "./notifications";
import { getProgressSummary } from "./progress";

/** Best-effort E.164 normalisation. Numbers without a country code are kept only as raw text. */
export function toE164(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let s = raw.replace(/[\s().-]/g, "");
  if (s.startsWith("00")) s = "+" + s.slice(2);
  if (/^[1-9]\d{6,14}$/.test(s)) s = "+" + s; // WhatsApp delivers numbers without '+'
  return /^\+[1-9]\d{6,14}$/.test(s) ? s : null;
}

export const createStudentSchema = z.object({
  firstName: z.string().trim().min(1).max(100),
  lastName: z.string().trim().max(100).default(""),
  email: z.string().trim().email().optional().or(z.literal("").transform(() => undefined)),
  phone: z.string().trim().max(40).optional(),
  dateOfBirth: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().or(z.literal("").transform(() => undefined)),
  licenseCategory: z.string().trim().min(1).max(5).default("B"),
  preferredTransmission: z.enum(["manual", "automatic"]).default("manual"),
  primaryInstructorId: z.string().uuid().optional().or(z.literal("").transform(() => undefined)),
  status: z.enum(["lead", "active"]).default("active"),
  source: z.enum(["manual", "whatsapp", "web", "import"]).default("manual"),
  createLogin: z.boolean().default(true),
  notes: z.string().max(5000).optional(),
});
export type CreateStudentInput = z.input<typeof createStudentSchema>;

/** Creates a user row + one-time activation token and queues the invite/welcome e-mail. */
export async function inviteUser(
  tx: Tx,
  p: Principal,
  args: { role: "student" | "instructor" | "school_admin" | "school_owner"; email: string; phone?: string | null; notificationType: "student_welcome" | "user_invite"; studentId?: string; name: string },
) {
  const user = (await one<{ id: string }>(
    tx,
    `INSERT INTO users (school_id, role, email, phone, status) VALUES ($1,$2,$3,$4,'invited') RETURNING id`,
    [p.schoolId, args.role, args.email, args.phone ?? null],
  ))!;
  const token = randomToken();
  await tx.query(
    `INSERT INTO user_invites (school_id, user_id, token_hash, purpose, expires_at) VALUES ($1,$2,$3,'activate', now() + interval '7 days')`,
    [p.schoolId, user.id, sha256Hex(token)],
  );
  await enqueueNotification(tx, {
    schoolId: p.schoolId,
    type: args.notificationType,
    to: args.email,
    userId: user.id,
    studentId: args.studentId ?? null,
    // activation_url is a secret: the notification worker scrubs it after sending.
    payload: { name: args.name, role: args.role, activation_url: `${env.appUrl}/activate/${token}` },
  });
  return user.id;
}

export async function createStudent(tx: Tx, p: Principal, raw: CreateStudentInput) {
  if (p.type === "user" && !can(p.actor.role, "students:write")) throw new ForbiddenError();
  const input = createStudentSchema.parse(raw);
  if (input.createLogin && !input.email) throw new ValidationError("An e-mail address is required to create a student login.");
  const number = await nextStudentNumber(tx, p.schoolId);
  const student = (await one<{ id: string }>(
    tx,
    `INSERT INTO students (school_id, student_number, first_name, last_name, phone, phone_e164, email, date_of_birth,
                           license_category, preferred_transmission, primary_instructor_id, status, source, notes)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING id`,
    [
      p.schoolId,
      number,
      input.firstName,
      input.lastName,
      input.phone ?? null,
      toE164(input.phone),
      input.email ?? null,
      input.dateOfBirth ?? null,
      input.licenseCategory,
      input.preferredTransmission,
      input.primaryInstructorId ?? null,
      input.status,
      input.source,
      input.notes ?? null,
    ],
  ))!;
  if (input.createLogin && input.email) {
    const userId = await inviteUser(tx, p, {
      role: "student",
      email: input.email,
      phone: input.phone,
      notificationType: "student_welcome",
      studentId: student.id,
      name: input.firstName,
    });
    await tx.query(`UPDATE students SET user_id = $2 WHERE id = $1`, [student.id, userId]);
  }
  await audit(tx, p, "student.created", "student", student.id, { student_number: number, source: input.source });
  return { id: student.id, studentNumber: number };
}

export const profileSchema = z.object({
  phone: z.string().trim().max(40).optional(),
  preferredTransmission: z.enum(["manual", "automatic"]).optional(),
  availability: z
    .array(z.object({ weekday: z.number().int().min(1).max(7), start: z.string().regex(/^\d{2}:\d{2}$/), end: z.string().regex(/^\d{2}:\d{2}$/) }))
    .max(21)
    .optional(),
});

/** Student self-service profile (a deliberately small set of fields). */
export async function updateOwnStudentProfile(tx: Tx, p: Principal, raw: z.input<typeof profileSchema>) {
  if (p.type !== "user" || p.actor.role !== "student" || !p.actor.studentId) throw new ForbiddenError();
  const input = profileSchema.parse(raw);
  const id = p.actor.studentId;
  if (input.phone !== undefined) {
    await tx.query(`UPDATE students SET phone = $2, phone_e164 = $3 WHERE id = $1`, [id, input.phone || null, toE164(input.phone)]);
  }
  if (input.preferredTransmission) {
    await tx.query(`UPDATE students SET preferred_transmission = $2 WHERE id = $1`, [id, input.preferredTransmission]);
  }
  if (input.availability) {
    for (const w of input.availability) if (w.end <= w.start) throw new ValidationError("Availability end must be after start");
    await tx.query(`DELETE FROM student_availability WHERE student_id = $1`, [id]);
    for (const w of input.availability) {
      await tx.query(
        `INSERT INTO student_availability (school_id, student_id, weekday, start_time, end_time) VALUES ($1,$2,$3,$4,$5)`,
        [p.schoolId, id, w.weekday, w.start, w.end],
      );
    }
  }
  await audit(tx, p, "student.profile_updated", "student", id);
}

/** Instructors see a student only if they teach them. */
export async function assertCanViewStudent(tx: Tx, p: Principal, studentId: string) {
  if (p.type !== "user") return;
  const a = p.actor;
  if (can(a.role, "students:read_all")) return;
  if (a.role === "student" && a.studentId === studentId) return;
  if (a.role === "instructor") {
    const ok = await one(
      tx,
      `SELECT 1 FROM students s WHERE s.id = $1 AND (s.primary_instructor_id = $2
         OR EXISTS (SELECT 1 FROM lessons l WHERE l.student_id = s.id AND l.instructor_id = $2))`,
      [studentId, a.instructorId],
    );
    if (ok) return;
  }
  throw new ForbiddenError();
}

export async function getStudentDashboard(tx: Tx, schoolId: string, studentId: string, locale = "en") {
  const ctx = await loadSchoolContext(tx, schoolId);
  const student = await one<{ id: string; first_name: string; last_name: string; student_number: string; email: string | null; phone: string | null; preferred_transmission: string; license_category: string }>(
    tx,
    `SELECT id, first_name, last_name, student_number, email, phone, preferred_transmission, license_category FROM students WHERE id = $1`,
    [studentId],
  );
  if (!student) throw new NotFoundError("Student");
  const now = await dbNow(tx);

  const [progress, feedback, upcoming, history, payments, availability, pendingRequests, ratings, driven] = await sequential([
    () => getProgressSummary(tx, studentId, locale),
    () => one<{ lesson_id: string; lesson_number: number; start_time: Date; instructor_name: string; strengths: string | null; weaknesses: string | null; practice_items: string | null; next_focus: string | null; overall_rating: number | null; seen_at: Date | null; total: number }>(
      tx,
      `SELECT f.lesson_id, l.lesson_number, l.start_time, i.first_name AS instructor_name,
              f.strengths, f.weaknesses, f.practice_items, f.next_focus, f.overall_rating, f.seen_at,
              (SELECT count(*)::int FROM lesson_feedback x WHERE x.student_id = f.student_id AND x.visible_to_student) AS total
         FROM lesson_feedback f JOIN lessons l ON l.id = f.lesson_id JOIN instructors i ON i.id = f.instructor_id
        WHERE f.student_id = $1 AND f.visible_to_student
        ORDER BY l.start_time DESC LIMIT 1`,
      [studentId],
    ),
    () => many<{ id: string; lesson_number: number; start_time: Date; end_time: Date; status: string; instructor_name: string; vehicle: string | null }>(
      tx,
      `SELECT l.id, l.lesson_number, l.start_time, l.end_time, l.status, i.first_name AS instructor_name,
              CASE WHEN v.id IS NULL THEN NULL ELSE v.brand || ' ' || v.model END AS vehicle
         FROM lessons l JOIN instructors i ON i.id = l.instructor_id LEFT JOIN vehicles v ON v.id = l.vehicle_id
        WHERE l.student_id = $1 AND l.status IN ('scheduled','confirmed','in_progress') AND l.end_time > $2
        ORDER BY l.start_time LIMIT 5`,
      [studentId, now],
    ),
    () => many<{ id: string; lesson_number: number; start_time: Date; end_time: Date; status: string; instructor_name: string; payment_status: string; has_feedback: boolean; strengths: string | null; next_focus: string | null }>(
      tx,
      `SELECT l.id, l.lesson_number, l.start_time, l.end_time, l.status, i.first_name AS instructor_name, l.payment_status,
              (f.id IS NOT NULL) AS has_feedback, f.strengths, f.next_focus
         FROM lessons l JOIN instructors i ON i.id = l.instructor_id
         LEFT JOIN lesson_feedback f ON f.lesson_id = l.id AND f.visible_to_student
        WHERE l.student_id = $1 AND l.status IN ('completed','no_show','cancelled')
        ORDER BY l.start_time DESC LIMIT 50`,
      [studentId],
    ),
    () => many<{ id: string; amount_cents: number; currency: string; status: string; due_date: string; paid_at: Date | null; reference: string; pay_token: string; lesson_number: number | null; lesson_start: Date | null }>(
      tx,
      `SELECT p.id, p.amount_cents, p.currency, p.status, p.due_date, p.paid_at, p.reference, p.pay_token,
              l.lesson_number, l.start_time AS lesson_start
         FROM payments p LEFT JOIN lessons l ON l.id = p.lesson_id
        WHERE p.student_id = $1 AND p.status <> 'cancelled'
        ORDER BY p.created_at DESC LIMIT 50`,
      [studentId],
    ),
    () => many<{ weekday: number; start_time: string; end_time: string }>(
      tx,
      `SELECT weekday, to_char(start_time,'HH24:MI') AS start_time, to_char(end_time,'HH24:MI') AS end_time FROM student_availability WHERE student_id = $1 ORDER BY weekday, start_time`,
      [studentId],
    ),
    () => many<{ lesson_id: string; requested_start: Date }>(
      tx,
      `SELECT lesson_id, requested_start FROM reschedule_requests WHERE student_id = $1 AND status = 'pending'`,
      [studentId],
    ),
    // Last ten instructor ratings, oldest first, for the rating trend line.
    () => many<{ lesson_number: number; start_time: Date; rating: number }>(
      tx,
      `SELECT * FROM (
         SELECT l.lesson_number, l.start_time, f.overall_rating AS rating
           FROM lesson_feedback f JOIN lessons l ON l.id = f.lesson_id
          WHERE f.student_id = $1 AND f.visible_to_student AND f.overall_rating IS NOT NULL
          ORDER BY l.start_time DESC LIMIT 10) r ORDER BY start_time`,
      [studentId],
    ),
    () => one<{ lessons: number; minutes: number }>(
      tx,
      `SELECT count(*)::int AS lessons, COALESCE(sum(extract(epoch FROM end_time - start_time) / 60), 0)::int AS minutes
         FROM lessons WHERE student_id = $1 AND status = 'completed'`,
      [studentId],
    )]);

  const upcomingWithPolicy = upcoming.map((l) => {
    const check = checkStudentReschedule({
      lessonStart: l.start_time,
      status: l.status as "scheduled",
      now,
      noticeHours: ctx.settings.min_reschedule_notice_hours,
      timezone: ctx.timezone,
    });
    return {
      ...l,
      canReschedule: check.allowed && !pendingRequests.some((r) => r.lesson_id === l.id),
      rescheduleDeadline: check.deadline,
      rescheduleBlockedReason: check.allowed ? null : check.message,
      rescheduleBlockedCode: check.allowed ? null : check.code,
      pendingRequest: pendingRequests.find((r) => r.lesson_id === l.id) ?? null,
    };
  });

  return {
    student,
    timezone: ctx.timezone,
    currency: ctx.currency,
    noticeHours: ctx.settings.min_reschedule_notice_hours,
    booking: {
      selfBooking: ctx.settings.student_self_booking,
      minutes: ctx.settings.default_lesson_minutes,
      priceCents: ctx.settings.default_lesson_price_cents,
    },
    progress,
    latestFeedback: feedback,
    ratings,
    driven: driven!,
    upcoming: upcomingWithPolicy,
    history,
    payments,
    availability,
  };
}
