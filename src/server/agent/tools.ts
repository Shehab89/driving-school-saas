/**
 * Tools the WhatsApp agent can call. Every tool:
 *  - validates its input with zod (the model's output is untrusted),
 *  - runs in the conversation's tenant (withTenant) with an ai_agent principal
 *    bound to the *verified* student of this conversation — the model can
 *    never choose whose data it reads or changes,
 *  - goes through the same services as the web app, so business rules
 *    (24h notice, double booking, etc.) apply identically.
 * Changes (book/reschedule/cancel) are two-step: propose -> the student
 * confirms in a later message -> confirm_pending_action.
 */
import { DateTime } from "luxon";
import { z } from "zod";
import type Anthropic from "@anthropic-ai/sdk";
import { many, one, withTenant } from "@/lib/db";
import { randomInt } from "node:crypto";
import { sha256Hex } from "@/lib/crypto";
import { AppError } from "@/lib/errors";
import { formatDateTime, formatMoney, formatTimeRange, formatDate } from "@/lib/time";
import type { Principal } from "../principal";
import { checkStudentCancellation, checkStudentReschedule } from "../policies";
import { dbNow, loadSchoolContext, searchSlots } from "../scheduling/loader";
import { bookLesson, cancelLesson, rescheduleLesson } from "../services/lessons";
import { createStudent, toE164 } from "../services/students";
import { createAssessment } from "../services/assessments";
import { assessmentAnswersSchema } from "../services/assessment-scoring";
import { enqueueNotification } from "../services/notifications";
import { payUrl } from "../services/billing";
import { audit } from "../services/audit";
import { env } from "@/lib/env";

export const INTENTS = [
  "greeting",
  "new_student",
  "existing_student",
  "book_lesson",
  "reschedule_lesson",
  "cancel_lesson",
  "check_upcoming_lesson",
  "payment",
  "availability",
  "prices",
  "school_info",
  "human_support",
  "other",
] as const;
export type Intent = (typeof INTENTS)[number];

export interface OfferedSlot {
  start: string;
  end: string;
  instructorId: string;
  vehicleId: string | null;
  purpose: "book" | "reschedule";
  lessonId?: string;
}

export interface AgentState {
  offered_slots?: Record<string, OfferedSlot>;
  pending_action?: {
    type: "book" | "reschedule" | "cancel";
    params: Record<string, string>;
    summary: string;
    proposed_at_message_id: string;
  };
  link?: { student_id: string | null; code_hash: string; expires_at: string; attempts: number };
  lock_until?: string;
}

export interface ToolContext {
  schoolId: string;
  conversationId: string;
  waPhone: string;
  /** Latest inbound message being answered. */
  messageId: string;
  studentId: string | null;
  state: AgentState;
  intents: Intent[];
  handoff: { reason: string } | null;
}

type ToolDef = Anthropic.Beta.BetaTool & { strict?: boolean };

const obj = (properties: Record<string, unknown>, required: string[] = Object.keys(properties)): ToolDef["input_schema"] => ({
  type: "object",
  properties,
  required,
  additionalProperties: false,
});

const DATE = { type: "string", description: "Local date YYYY-MM-DD in the school's timezone" };

export const COMMON_TOOLS: ToolDef[] = [
  {
    name: "record_intent",
    description: "Record the intent of the contact's latest message. Call once per incoming message, before other tools.",
    strict: true,
    input_schema: obj({ intent: { type: "string", enum: [...INTENTS] } }),
  },
  {
    name: "get_school_info",
    description: "Opening hours, address, contact details, lesson prices and durations, cancellation/reschedule policy, and the school's FAQ text.",
    strict: true,
    input_schema: obj({}),
  },
  {
    name: "request_human",
    description: "Hand the conversation to a human at the school. Use when asked for a person, for complaints, medical/legal/safety questions, anything you cannot do with your tools, or when unsure.",
    strict: true,
    input_schema: obj({ reason: { type: "string" } }),
  },
];

export const UNKNOWN_CONTACT_TOOLS: ToolDef[] = [
  {
    name: "find_my_student_account",
    description:
      "For a contact who says they are already a student but writes from an unknown number. Sends a 6-digit verification code to the e-mail on the student record (if any). Never reveals whether the e-mail exists.",
    strict: true,
    input_schema: obj({ email: { type: "string" } }),
  },
  {
    name: "verify_link_code",
    description: "Verify the 6-digit code the contact received by e-mail and link this WhatsApp number to their student record.",
    strict: true,
    input_schema: obj({ code: { type: "string" } }),
  },
  {
    name: "register_new_student",
    description:
      "Register a new student (lead) once you have collected their details. Call only after the contact confirmed the details are correct.",
    strict: true,
    input_schema: obj(
      {
        first_name: { type: "string" },
        last_name: { type: "string" },
        email: { type: ["string", "null"] },
        phone: { type: ["string", "null"], description: "Only if different from this WhatsApp number; international format" },
        license_category: { type: "string", description: "e.g. B (car), A (motorcycle)" },
        transmission: { type: "string", enum: ["manual", "automatic"] },
        previous_experience: { type: "string" },
        preferred_times_text: { type: "string", description: "The contact's own words" },
        preferred_windows: {
          type: "array",
          description: "Structured version of the preferred times",
          items: obj({
            weekday: { type: "integer", description: "1 = Monday … 7 = Sunday" },
            start: { type: "string", description: "HH:MM" },
            end: { type: "string", description: "HH:MM" },
          }),
        },
      },
      ["first_name", "last_name", "email", "phone", "license_category", "transmission", "previous_experience", "preferred_times_text", "preferred_windows"],
    ),
  },
];

const ASSESSMENT_TOOL: ToolDef = {
  name: "submit_assessment",
  description:
    "Submit the new student's answers to the short driving-experience questions. Returns a SUGGESTED starting level computed by the school's rules; you must present it as a suggestion that an instructor will confirm.",
  strict: true,
  input_schema: obj(
    {
      has_driven_before: { type: "boolean" },
      previous_lessons: { type: "string", enum: ["none", "few", "some", "many"], description: "few < 10, some 10–20, many > 20" },
      approx_driving_hours: { type: ["number", "null"] },
      can_drive_manual: { type: "string", enum: ["yes", "no", "unsure"] },
      traffic_comfort: { type: "integer", description: "1 = very nervous … 5 = fully comfortable" },
      has_foreign_license: { type: "boolean" },
      wants_transmission: { type: "string", enum: ["manual", "automatic"] },
    },
    ["has_driven_before", "previous_lessons", "approx_driving_hours", "can_drive_manual", "traffic_comfort", "has_foreign_license", "wants_transmission"],
  ),
};

export const STUDENT_TOOLS: ToolDef[] = [
  ASSESSMENT_TOOL,
  {
    name: "get_my_lessons",
    description: "The student's upcoming lessons (with ids, and whether they can still be rescheduled/cancelled online) and optionally recent history.",
    strict: true,
    input_schema: obj({ include_history: { type: "boolean" } }),
  },
  {
    name: "get_my_payments",
    description: "The student's open and recent payments with secure payment links.",
    strict: true,
    input_schema: obj({}),
  },
  {
    name: "find_available_slots",
    description:
      "Search real available lesson slots (instructor + car + school hours + the student's other lessons). Returns labelled options (A, B, C…) to show the student. For a reschedule pass the lesson_id.",
    strict: true,
    input_schema: obj(
      {
        from_date: DATE,
        to_date: DATE,
        part_of_day: { type: "string", enum: ["any", "morning", "afternoon", "evening"] },
        purpose: { type: "string", enum: ["book", "reschedule"] },
        lesson_id: { type: ["string", "null"] },
      },
      ["from_date", "to_date", "part_of_day", "purpose", "lesson_id"],
    ),
  },
  {
    name: "propose_booking",
    description: "Prepare booking of an offered slot. Does NOT book yet; ask the student to confirm.",
    strict: true,
    input_schema: obj({ slot_label: { type: "string" } }),
  },
  {
    name: "propose_reschedule",
    description: "Prepare moving a lesson to an offered slot. Does NOT change anything yet; ask the student to confirm.",
    strict: true,
    input_schema: obj({ lesson_id: { type: "string" }, slot_label: { type: "string" } }),
  },
  {
    name: "propose_cancellation",
    description: "Prepare cancelling a lesson. Does NOT cancel yet; ask the student to confirm.",
    strict: true,
    input_schema: obj({ lesson_id: { type: "string" }, reason: { type: "string" } }),
  },
  {
    name: "confirm_pending_action",
    description: "Execute the proposed booking/reschedule/cancellation. Only call after the student explicitly confirmed (e.g. 'yes') in a NEW message.",
    strict: true,
    input_schema: obj({}),
  },
  {
    name: "cancel_pending_action",
    description: "Discard the proposed action when the student declines or changes their mind.",
    strict: true,
    input_schema: obj({}),
  },
];

export function toolsFor(studentKnown: boolean): ToolDef[] {
  return studentKnown ? [...COMMON_TOOLS, ...STUDENT_TOOLS] : [...COMMON_TOOLS, ...UNKNOWN_CONTACT_TOOLS, ASSESSMENT_TOOL];
}

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

const agentPrincipal = (ctx: ToolContext): Principal => ({
  type: "ai_agent",
  schoolId: ctx.schoolId,
  studentId: ctx.studentId,
  conversationId: ctx.conversationId,
});

function requireStudent(ctx: ToolContext): string {
  if (!ctx.studentId) throw new AppError("This contact is not linked to a student yet.", 403, "not_identified");
  return ctx.studentId;
}

/** Keyed with the server secret so a leaked state row doesn't allow brute-forcing the 6 digits offline. */
function linkCodeHash(conversationId: string, code: string) {
  return sha256Hex(`${env.sessionSecret}:${conversationId}:${code}`);
}

const PART_OF_DAY: Record<string, [number, number]> = { any: [0, 24], morning: [6, 12], afternoon: [12, 17], evening: [17, 23] };

export type ToolResult = Record<string, unknown>;

export async function executeTool(name: string, rawInput: unknown, ctx: ToolContext): Promise<ToolResult> {
  const input = (rawInput ?? {}) as Record<string, unknown>;
  switch (name) {
    case "record_intent": {
      const { intent } = z.object({ intent: z.enum(INTENTS) }).parse(input);
      ctx.intents.push(intent);
      return { ok: true };
    }

    case "get_school_info":
      return withTenant(ctx.schoolId, async (tx) => {
        const school = await one<{ name: string; address: string | null; phone: string | null; email: string | null; timezone: string; currency: string }>(
          tx,
          `SELECT name, address, phone, email, timezone, currency FROM schools WHERE id = $1`,
          [ctx.schoolId],
        );
        const sc = await loadSchoolContext(tx, ctx.schoolId);
        const hours = await many<{ weekday: number; opens: string; closes: string }>(
          tx,
          `SELECT weekday, to_char(opens_at,'HH24:MI') AS opens, to_char(closes_at,'HH24:MI') AS closes FROM school_opening_hours ORDER BY weekday, opens_at`,
        );
        const days = ["", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
        return {
          ...school,
          opening_hours: hours.map((h) => `${days[h.weekday]} ${h.opens}–${h.closes}`),
          lesson: {
            duration_minutes: sc.settings.default_lesson_minutes,
            price: formatMoney(sc.settings.default_lesson_price_cents, sc.currency),
          },
          policy: {
            reschedule_notice_hours: sc.settings.min_reschedule_notice_hours,
            cancellation_notice_hours: sc.settings.min_cancellation_notice_hours,
            late_cancellation_fee: sc.settings.late_cancellation_fee_cents ? formatMoney(sc.settings.late_cancellation_fee_cents, sc.currency) : null,
            payment_due_days: sc.settings.payment_due_days,
          },
          faq: sc.settings.school_info_for_agent ?? null,
        };
      });

    case "request_human": {
      const { reason } = z.object({ reason: z.string().max(500) }).parse(input);
      ctx.handoff = { reason };
      return { ok: true, note: "A team member will reply in this chat. Tell the contact that." };
    }

    case "find_my_student_account": {
      const { email } = z.object({ email: z.string().trim().email().max(200) }).parse(input);
      await withTenant(ctx.schoolId, async (tx) => {
        const student = await one<{ id: string; email: string }>(
          tx,
          `SELECT id, email FROM students WHERE email = $1 AND status <> 'archived' ORDER BY created_at DESC LIMIT 1`,
          [email],
        );
        const code = String(randomInt(100000, 1000000));
        // Store state even when not found, so the flow looks identical (no account enumeration).
        ctx.state.link = {
          student_id: student?.id ?? null,
          code_hash: linkCodeHash(ctx.conversationId, code),
          expires_at: DateTime.now().plus({ minutes: 15 }).toISO()!,
          attempts: 0,
        };
        if (student) {
          await enqueueNotification(tx, {
            schoolId: ctx.schoolId,
            type: "whatsapp_link_code",
            to: student.email,
            studentId: student.id,
            payload: { code },
          });
        }
      });
      return { ok: true, message: "If this e-mail belongs to a student, a 6-digit code has been sent to it. Ask the contact to reply with the code." };
    }

    case "verify_link_code": {
      const { code } = z.object({ code: z.string().trim().regex(/^\d{6}$/) }).parse(input);
      const link = ctx.state.link;
      if (!link || DateTime.fromISO(link.expires_at) < DateTime.now()) return { ok: false, error: "No valid code request. Offer to send a new code." };
      link.attempts += 1;
      if (link.attempts > 5) {
        delete ctx.state.link;
        return { ok: false, error: "Too many attempts. Hand over to a human." };
      }
      if (!link.student_id || linkCodeHash(ctx.conversationId, code) !== link.code_hash) {
        return { ok: false, error: "Code is not correct." };
      }
      const studentId = link.student_id;
      await withTenant(ctx.schoolId, async (tx) => {
        await tx.query(`UPDATE whatsapp_conversations SET student_id = $2 WHERE id = $1`, [ctx.conversationId, studentId]);
        // Save the number for future matching unless another live student already uses it.
        await tx.query(
          `UPDATE students SET phone_e164 = $2, phone = COALESCE(phone, $2)
            WHERE id = $1 AND phone_e164 IS NULL
              AND NOT EXISTS (SELECT 1 FROM students o WHERE o.phone_e164 = $2 AND o.status <> 'archived')`,
          [studentId, ctx.waPhone],
        );
        await audit(tx, agentPrincipal(ctx), "whatsapp.number_linked", "student", studentId, { phone: ctx.waPhone });
      });
      ctx.studentId = studentId;
      delete ctx.state.link;
      return { ok: true, linked: true, note: "Identity verified. You can now help with lessons and payments." };
    }

    case "register_new_student": {
      const i = z
        .object({
          first_name: z.string().trim().min(1).max(100),
          last_name: z.string().trim().max(100),
          email: z.string().trim().email().nullable(),
          phone: z.string().trim().max(40).nullable(),
          license_category: z.string().trim().min(1).max(5),
          transmission: z.enum(["manual", "automatic"]),
          previous_experience: z.string().max(1000),
          preferred_times_text: z.string().max(500),
          preferred_windows: z
            .array(z.object({ weekday: z.number().int().min(1).max(7), start: z.string().regex(/^\d{2}:\d{2}$/), end: z.string().regex(/^\d{2}:\d{2}$/) }))
            .max(14),
        })
        .parse(input);
      if (ctx.studentId) return { ok: false, error: "This contact is already registered." };
      const phone = i.phone && toE164(i.phone) ? i.phone : ctx.waPhone;
      const created = await withTenant(ctx.schoolId, async (tx) => {
        const s = await createStudent(tx, agentPrincipal(ctx), {
          firstName: i.first_name,
          lastName: i.last_name,
          email: i.email ?? undefined,
          phone,
          licenseCategory: i.license_category.toUpperCase(),
          preferredTransmission: i.transmission,
          status: "lead",
          source: "whatsapp",
          createLogin: Boolean(i.email),
          notes: `Experience: ${i.previous_experience}\nPreferred times: ${i.preferred_times_text}`,
        });
        // The WhatsApp number always identifies the conversation.
        await tx.query(`UPDATE students SET phone_e164 = $2 WHERE id = $1 AND phone_e164 IS NULL`, [s.id, ctx.waPhone]).catch(() => {});
        for (const w of i.preferred_windows.filter((w) => w.end > w.start)) {
          await tx.query(`INSERT INTO student_availability (school_id, student_id, weekday, start_time, end_time) VALUES ($1,$2,$3,$4,$5)`, [
            ctx.schoolId,
            s.id,
            w.weekday,
            w.start,
            w.end,
          ]);
        }
        await tx.query(`UPDATE whatsapp_conversations SET student_id = $2 WHERE id = $1`, [ctx.conversationId, s.id]);
        return s;
      });
      ctx.studentId = created.id;
      return { ok: true, student_number: created.studentNumber, next: "Now ask the short assessment questions, then call submit_assessment." };
    }

    case "submit_assessment": {
      const studentId = requireStudent(ctx);
      const answers = assessmentAnswersSchema.parse(input);
      const result = await withTenant(ctx.schoolId, (tx) => createAssessment(tx, agentPrincipal(ctx), { studentId, answers, source: "whatsapp_agent" }));
      return {
        ok: true,
        suggested_band: result.band,
        suggested_level: result.level?.name ?? result.band,
        confidence: result.confidence,
        instruction: "Say this is a suggested starting level and that an instructor will confirm it during the first lesson.",
      };
    }

    case "get_my_lessons": {
      const studentId = requireStudent(ctx);
      const { include_history } = z.object({ include_history: z.boolean() }).parse(input);
      return withTenant(ctx.schoolId, async (tx) => {
        const sc = await loadSchoolContext(tx, ctx.schoolId);
        const now = await dbNow(tx);
        const upcoming = await many<{ id: string; lesson_number: number; start_time: Date; end_time: Date; status: string; instructor: string; vehicle: string | null }>(
          tx,
          `SELECT l.id, l.lesson_number, l.start_time, l.end_time, l.status, i.first_name AS instructor,
                  CASE WHEN v.id IS NULL THEN NULL ELSE v.brand || ' ' || v.model END AS vehicle
             FROM lessons l JOIN instructors i ON i.id = l.instructor_id LEFT JOIN vehicles v ON v.id = l.vehicle_id
            WHERE l.student_id = $1 AND l.status IN ('scheduled','confirmed') AND l.start_time > $2
            ORDER BY l.start_time LIMIT 10`,
          [studentId, now],
        );
        const history = include_history
          ? await many<{ lesson_number: number; start_time: Date; status: string; payment_status: string }>(
              tx,
              `SELECT lesson_number, start_time, status, payment_status FROM lessons
                WHERE student_id = $1 AND status IN ('completed','no_show','cancelled') ORDER BY start_time DESC LIMIT 5`,
              [studentId],
            )
          : [];
        return {
          timezone: sc.timezone,
          upcoming: upcoming.map((l) => {
            const r = checkStudentReschedule({ lessonStart: l.start_time, status: l.status as "scheduled", now, noticeHours: sc.settings.min_reschedule_notice_hours, timezone: sc.timezone });
            const c = checkStudentCancellation({ lessonStart: l.start_time, status: l.status as "scheduled", now, noticeHours: sc.settings.min_cancellation_notice_hours, timezone: sc.timezone });
            return {
              lesson_id: l.id,
              lesson_number: l.lesson_number,
              when: `${formatDate(l.start_time, sc.timezone)} ${formatTimeRange(l.start_time, l.end_time, sc.timezone)}`,
              instructor: l.instructor,
              vehicle: l.vehicle,
              can_reschedule_online: r.allowed,
              can_cancel_online: c.allowed,
              change_deadline: r.deadline ? formatDateTime(r.deadline, sc.timezone) : null,
            };
          }),
          history: history.map((h) => ({ lesson_number: h.lesson_number, date: formatDate(h.start_time, sc.timezone), status: h.status, payment: h.payment_status })),
        };
      });
    }

    case "get_my_payments": {
      const studentId = requireStudent(ctx);
      return withTenant(ctx.schoolId, async (tx) => {
        const sc = await loadSchoolContext(tx, ctx.schoolId);
        const rows = await many<{ amount_cents: number; currency: string; status: string; due_date: string; pay_token: string; reference: string }>(
          tx,
          `SELECT amount_cents, currency, status, due_date, pay_token, reference FROM payments
            WHERE student_id = $1 AND status IN ('pending','overdue','failed','paid') ORDER BY created_at DESC LIMIT 10`,
          [studentId],
        );
        return {
          payments: rows.map((r) => ({
            amount: formatMoney(r.amount_cents, r.currency),
            status: r.status,
            due: formatDate(`${r.due_date}T12:00:00Z`, sc.timezone),
            reference: r.reference,
            pay_link: ["pending", "overdue", "failed"].includes(r.status) ? payUrl(r.pay_token) : null,
          })),
        };
      });
    }

    case "find_available_slots": {
      const studentId = requireStudent(ctx);
      const i = z
        .object({
          from_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
          to_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
          part_of_day: z.enum(["any", "morning", "afternoon", "evening"]),
          purpose: z.enum(["book", "reschedule"]),
          lesson_id: z.string().uuid().nullable(),
        })
        .parse(input);
      return withTenant(ctx.schoolId, async (tx) => {
        const sc = await loadSchoolContext(tx, ctx.schoolId);
        if (i.purpose === "book" && !sc.settings.ai_agent_can_book) return { ok: false, error: "Booking via WhatsApp is disabled; offer a human." };
        let duration = sc.settings.default_lesson_minutes;
        if (i.purpose === "reschedule") {
          if (!i.lesson_id) return { ok: false, error: "lesson_id is required for a reschedule." };
          const l = await one<{ student_id: string; start_time: Date; end_time: Date; status: string }>(tx, `SELECT student_id, start_time, end_time, status FROM lessons WHERE id = $1`, [i.lesson_id]);
          if (!l || l.student_id !== studentId) return { ok: false, error: "Lesson not found." };
          const check = checkStudentReschedule({ lessonStart: l.start_time, status: l.status as "scheduled", now: await dbNow(tx), noticeHours: sc.settings.min_reschedule_notice_hours, timezone: sc.timezone });
          if (!check.allowed) return { ok: false, error: check.message };
          duration = Math.round((l.end_time.getTime() - l.start_time.getTime()) / 60000);
        }
        const from = DateTime.fromISO(i.from_date, { zone: sc.timezone }).startOf("day");
        const to = DateTime.fromISO(i.to_date, { zone: sc.timezone }).endOf("day");
        if (!from.isValid || !to.isValid || to < from) return { ok: false, error: "Invalid dates." };
        const [h0, h1] = PART_OF_DAY[i.part_of_day]!;
        const slots = (
          await searchSlots(tx, sc, {
            studentId,
            from: from.toJSDate(),
            to: DateTime.min(to, from.plus({ days: 31 })).toJSDate(),
            durationMinutes: duration,
            ignoreLessonIds: i.lesson_id ? [i.lesson_id] : [],
            distinctTimes: true,
            maxSlots: 200,
          })
        ).filter((s) => {
          const h = DateTime.fromJSDate(s.start, { zone: sc.timezone }).hour;
          return h >= h0 && h < h1;
        });
        // Spread the options across days rather than returning six slots on the first morning.
        const picked: typeof slots = [];
        const perDay = new Map<string, number>();
        for (const s of slots) {
          const day = DateTime.fromJSDate(s.start, { zone: sc.timezone }).toISODate()!;
          if ((perDay.get(day) ?? 0) >= 2) continue;
          perDay.set(day, (perDay.get(day) ?? 0) + 1);
          picked.push(s);
          if (picked.length === 6) break;
        }
        const labels = "ABCDEF";
        ctx.state.offered_slots = {};
        const options = picked.map((s, idx) => {
          const label = labels[idx]!;
          ctx.state.offered_slots![label] = {
            start: s.start.toISOString(),
            end: s.end.toISOString(),
            instructorId: s.instructorId,
            vehicleId: s.vehicleId,
            purpose: i.purpose,
            lessonId: i.lesson_id ?? undefined,
          };
          return { label, when: `${formatDate(s.start, sc.timezone)} ${formatTimeRange(s.start, s.end, sc.timezone)}` };
        });
        return { ok: true, options, note: options.length ? "Show these options with their labels." : "No free slots in that range; suggest another range." };
      });
    }

    case "propose_booking":
    case "propose_reschedule": {
      requireStudent(ctx);
      const i = z.object({ slot_label: z.string().trim().toUpperCase(), lesson_id: z.string().uuid().optional() }).parse(input);
      const slot = ctx.state.offered_slots?.[i.slot_label];
      if (!slot) return { ok: false, error: "Unknown option. Search slots again." };
      const isReschedule = name === "propose_reschedule";
      if (isReschedule && (!i.lesson_id || slot.lessonId !== i.lesson_id)) return { ok: false, error: "That option was offered for a different lesson." };
      const tz = await withTenant(ctx.schoolId, async (tx) => (await loadSchoolContext(tx, ctx.schoolId)).timezone);
      const when = `${formatDate(slot.start, tz)} ${formatTimeRange(slot.start, slot.end, tz)}`;
      ctx.state.pending_action = {
        type: isReschedule ? "reschedule" : "book",
        params: { slot_label: i.slot_label, ...(i.lesson_id ? { lesson_id: i.lesson_id } : {}) },
        summary: isReschedule ? `Move the lesson to ${when}` : `Book a lesson on ${when}`,
        proposed_at_message_id: ctx.messageId,
      };
      return { ok: true, confirm_question: `${ctx.state.pending_action.summary}. Shall I go ahead? (yes/no)` };
    }

    case "propose_cancellation": {
      const studentId = requireStudent(ctx);
      const i = z.object({ lesson_id: z.string().uuid(), reason: z.string().trim().min(1).max(300) }).parse(input);
      return withTenant(ctx.schoolId, async (tx) => {
        const sc = await loadSchoolContext(tx, ctx.schoolId);
        const l = await one<{ student_id: string; start_time: Date; end_time: Date; status: string }>(tx, `SELECT student_id, start_time, end_time, status FROM lessons WHERE id = $1`, [i.lesson_id]);
        if (!l || l.student_id !== studentId) return { ok: false, error: "Lesson not found." };
        const check = checkStudentCancellation({ lessonStart: l.start_time, status: l.status as "scheduled", now: await dbNow(tx), noticeHours: sc.settings.min_cancellation_notice_hours, timezone: sc.timezone });
        if (!check.allowed) return { ok: false, error: check.message };
        ctx.state.pending_action = {
          type: "cancel",
          params: { lesson_id: i.lesson_id, reason: i.reason },
          summary: `Cancel the lesson on ${formatDate(l.start_time, sc.timezone)} ${formatTimeRange(l.start_time, l.end_time, sc.timezone)}`,
          proposed_at_message_id: ctx.messageId,
        };
        return { ok: true, confirm_question: `${ctx.state.pending_action.summary}. Are you sure? (yes/no)` };
      });
    }

    case "confirm_pending_action": {
      requireStudent(ctx);
      const pending = ctx.state.pending_action;
      if (!pending) return { ok: false, error: "Nothing to confirm." };
      // The confirmation must come in a later message than the proposal.
      if (pending.proposed_at_message_id === ctx.messageId) {
        return { ok: false, error: "Ask the student to confirm first; you cannot confirm in the same turn as the proposal." };
      }
      delete ctx.state.pending_action;
      const p = agentPrincipal(ctx);
      try {
        return await withTenant(ctx.schoolId, async (tx) => {
          const sc = await loadSchoolContext(tx, ctx.schoolId);
          if (pending.type === "cancel") {
            await cancelLesson(tx, p, pending.params.lesson_id!, `Cancelled via WhatsApp: ${pending.params.reason}`);
            return { ok: true, done: pending.summary };
          }
          const offered = ctx.state.offered_slots?.[pending.params.slot_label!];
          if (!offered) return { ok: false, error: "The option expired. Search again." };
          const slot = { start: new Date(offered.start), end: new Date(offered.end), instructorId: offered.instructorId, vehicleId: offered.vehicleId };
          if (pending.type === "book") {
            if (!sc.settings.ai_agent_can_book) return { ok: false, error: "Booking via WhatsApp is disabled." };
            const lesson = await bookLesson(tx, p, { studentId: ctx.studentId!, slot, bookedVia: "whatsapp_agent" });
            delete ctx.state.offered_slots;
            return { ok: true, done: pending.summary, lesson_number: lesson.lesson_number, note: "A confirmation e-mail is sent if we have their e-mail." };
          }
          const r = await rescheduleLesson(tx, p, pending.params.lesson_id!, slot, { channel: "whatsapp_agent" });
          delete ctx.state.offered_slots;
          return r.status === "pending_approval"
            ? { ok: true, done: "Reschedule request sent to the school for approval." }
            : { ok: true, done: pending.summary };
        });
      } catch (err) {
        if (err instanceof AppError) return { ok: false, error: err.message, code: err.code };
        throw err;
      }
    }

    case "cancel_pending_action":
      delete ctx.state.pending_action;
      return { ok: true };

    default:
      return { ok: false, error: `Unknown tool ${name}` };
  }
}

