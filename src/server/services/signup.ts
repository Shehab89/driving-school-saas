/**
 * Public self-signup ("Book my first lesson"): a prospective student fills a
 * short survey (contact details, a password, and the same assessment
 * questions the WhatsApp agent asks). We create their account and a
 * suggested level for the school to confirm, activate the account with the
 * password they just chose (the caller then signs them in), and they land
 * on the booking calendar in the same visit — no waiting on an e-mail.
 *
 * No session exists yet, so account creation runs as the "system" principal,
 * exactly like the WhatsApp agent's own account creation — never as an
 * authenticated user — and the caller must have already resolved which
 * school this is for.
 */
import { z } from "zod";
import { many, one, withPlatform, withTenant, type Tx } from "@/lib/db";
import { ConflictError } from "@/lib/errors";
import { loadSchoolContext } from "@/server/scheduling/loader";
import { acceptInvite } from "./auth";
import { assessmentAnswersSchema } from "./assessment-scoring";
import { createAssessment } from "./assessments";
import { createStudent } from "./students";

export const joinSchema = z.object({
  firstName: z.string().trim().min(1).max(100),
  lastName: z.string().trim().min(1).max(100),
  email: z.string().trim().email(),
  phone: z.string().trim().min(6).max(40),
  password: z.string().min(10).max(200),
  answers: assessmentAnswersSchema,
});
export type JoinInput = z.input<typeof joinSchema>;

/** Public: which school a /join/<slug> (or bare /join, when only one exists) link is for, and whether it accepts sign-ups. */
export type SignupSchool = { id: string; name: string; timezone: string; currency: string; minutes: number; priceCents: number };

export async function findSchoolForSignup(
  slug?: string,
): Promise<{ ok: true; school: SignupSchool } | { ok: false; reason: "not_found" | "not_accepting" } | { ok: false; reason: "choose"; schools: { slug: string; name: string }[] }> {
  if (!slug) {
    // Bare /join: straight in when there is one school taking sign-ups, otherwise let the student pick.
    const open = await withPlatform((tx) =>
      many<{ slug: string; name: string }>(
        tx,
        `SELECT s.slug, s.name FROM schools s JOIN school_settings ss ON ss.school_id = s.id
          WHERE s.status IN ('trial','active') AND ss.student_self_booking ORDER BY s.name`,
      ),
    );
    if (open.length === 0) return { ok: false, reason: "not_accepting" };
    if (open.length > 1) return { ok: false, reason: "choose", schools: open };
    slug = open[0]!.slug;
  }
  const school = await withPlatform((tx) =>
    one<{ id: string; name: string }>(
      tx,
      `SELECT id, name FROM schools WHERE slug = $1 AND status IN ('trial','active')`,
      [slug],
    ),
  );
  if (!school) return { ok: false, reason: "not_found" };
  return withTenant(school.id, async (tx) => {
    const ctx = await loadSchoolContext(tx, school.id);
    if (!ctx.settings.student_self_booking) return { ok: false, reason: "not_accepting" };
    return {
      ok: true,
      school: {
        id: school.id,
        name: school.name,
        timezone: ctx.timezone,
        currency: ctx.currency,
        minutes: ctx.settings.default_lesson_minutes,
        priceCents: ctx.settings.default_lesson_price_cents,
      },
    };
  });
}

/**
 * Creates the student + assessment. Returns the activation token so the
 * caller can activate the account with the password the student chose
 * (via acceptInvite, in its own transaction — see the /join page action)
 * and only then build a session; that way a rollback here never leaves a
 * password set on a row that didn't actually get created.
 */
export async function signUpStudent(tx: Tx, schoolId: string, raw: JoinInput) {
  const input = joinSchema.parse(raw);
  const email = input.email.toLowerCase();
  const dup = await one(tx, `SELECT 1 FROM users WHERE school_id = $1 AND email = $2`, [schoolId, email]);
  if (dup) throw new ConflictError("An account with this e-mail already exists. Please sign in instead.", "already_registered");

  const system = { type: "system" as const, schoolId };
  const { id: studentId, activationToken } = await createStudent(tx, system, {
    firstName: input.firstName,
    lastName: input.lastName,
    email,
    phone: input.phone,
    licenseCategory: "B",
    preferredTransmission: input.answers.wants_transmission,
    status: "active",
    source: "web",
    createLogin: true,
  });
  await createAssessment(tx, system, { studentId, answers: input.answers, source: "web_form" });
  return { studentId, activationToken: activationToken! };
}
