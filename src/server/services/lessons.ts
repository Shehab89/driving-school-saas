import { DateTime } from "luxon";
import { many, one, type Tx } from "@/lib/db";
import { ConflictError, ForbiddenError, NotFoundError, PolicyError, ValidationError } from "@/lib/errors";
import { can } from "@/lib/rbac";
import type { Principal } from "../principal";
import { checkStudentCancellation, checkStudentReschedule, isLateCancellation, type LessonStatus } from "../policies";
import { dbNow, loadSchoolContext, revalidateSlot, searchSlots, type SchoolSchedulingContext } from "../scheduling/loader";
import type { Slot } from "../scheduling/engine";
import { audit } from "./audit";
import { enqueueNotification } from "./notifications";
import { createInvoiceAndPaymentForLesson, createCancellationFeeInvoice } from "./billing";
import { applyProgressUpdate, type SkillUpdate } from "./progress";

export interface LessonRow {
  id: string;
  school_id: string;
  student_id: string;
  instructor_id: string;
  vehicle_id: string | null;
  start_time: Date;
  end_time: Date;
  status: LessonStatus;
  lesson_number: number;
  lesson_type: string;
  price_cents: number;
  currency: string;
  payment_status: string;
  rescheduled_from_id: string | null;
}

export async function lockLesson(tx: Tx, lessonId: string): Promise<LessonRow> {
  const l = await one<LessonRow>(tx, `SELECT * FROM lessons WHERE id = $1 FOR UPDATE`, [lessonId]);
  if (!l) throw new NotFoundError("Lesson");
  return l;
}

type LessonAction = "operate" | "student_change";

/** Ownership rules on top of role permissions. */
export function assertLessonAccess(p: Principal, lesson: LessonRow, action: LessonAction) {
  switch (p.type) {
    case "system":
    case "webhook":
      return;
    case "ai_agent":
      if (action === "student_change" && p.studentId === lesson.student_id) return;
      throw new ForbiddenError();
    case "user": {
      const a = p.actor;
      if (can(a.role, "lessons:write_all")) return;
      if (action === "operate" && a.role === "instructor" && a.instructorId === lesson.instructor_id) return;
      if (action === "student_change" && a.role === "student" && a.studentId === lesson.student_id) return;
      throw new ForbiddenError();
    }
  }
}

const isStaff = (p: Principal) => p.type === "system" || (p.type === "user" && can(p.actor.role, "lessons:write_all"));
const isInstructorOrStaff = (p: Principal) =>
  isStaff(p) || (p.type === "user" && p.actor.role === "instructor");

/**
 * Lesson numbers follow the chronological order of a student's live lessons,
 * so booking an earlier lesson later, or cancelling one, keeps the sequence
 * right. Superseded (cancelled/rescheduled) lessons keep their old number.
 */
export async function renumberStudentLessons(tx: Tx, studentId: string) {
  await tx.query(
    `UPDATE lessons l SET lesson_number = x.rn
       FROM (SELECT id, row_number() OVER (ORDER BY start_time, created_at) AS rn
               FROM lessons WHERE student_id = $1 AND status NOT IN ('cancelled','rescheduled')) x
      WHERE l.id = x.id AND l.lesson_number <> x.rn`,
    [studentId],
  );
}

export function priceForDuration(ctx: SchoolSchedulingContext, minutes: number): number {
  const s = ctx.settings;
  return Math.round((s.default_lesson_price_cents * minutes) / s.default_lesson_minutes);
}

/** Snapshot used to render e-mails (kept in the notification so later edits don't change what was sent). */
export async function lessonSnapshot(tx: Tx, lessonId: string) {
  return one<{
    lesson_id: string;
    lesson_number: number;
    start_time: string;
    end_time: string;
    student_id: string;
    student_first_name: string;
    student_email: string | null;
    student_phone_e164: string | null;
    instructor_name: string;
    vehicle: string | null;
    price_cents: number;
    currency: string;
  }>(
    tx,
    `SELECT l.id AS lesson_id, l.lesson_number, l.start_time, l.end_time, l.price_cents, l.currency,
            s.id AS student_id, s.first_name AS student_first_name, s.email AS student_email, s.phone_e164 AS student_phone_e164,
            i.first_name || ' ' || i.last_name AS instructor_name,
            CASE WHEN v.id IS NULL THEN NULL ELSE v.brand || ' ' || v.model END AS vehicle
       FROM lessons l
       JOIN students s ON s.id = l.student_id
       JOIN instructors i ON i.id = l.instructor_id
       LEFT JOIN vehicles v ON v.id = l.vehicle_id
      WHERE l.id = $1`,
    [lessonId],
  );
}

// ---------------------------------------------------------------------------
// Booking
// ---------------------------------------------------------------------------

export interface BookLessonInput {
  studentId: string;
  slot: Slot;
  lessonType?: "practical" | "exam_prep" | "exam" | "assessment";
  priceCents?: number;
  notes?: string;
  /** Staff can place a lesson outside the published availability; DB constraints still prevent double booking. */
  overrideAvailability?: boolean;
  bookedVia: "staff" | "student_portal" | "whatsapp_agent";
  rescheduledFromId?: string;
}

export async function bookLesson(tx: Tx, p: Principal, input: BookLessonInput): Promise<LessonRow> {
  const ctx = await loadSchoolContext(tx, p.schoolId);
  if (p.type === "user" && !can(p.actor.role, "lessons:write_all")) {
    const a = p.actor;
    const ownStudent = a.role === "student" && a.studentId === input.studentId;
    const ownCalendar = a.role === "instructor" && a.instructorId === input.slot.instructorId;
    if (!ownStudent && !ownCalendar) throw new ForbiddenError();
  }
  if (p.type === "ai_agent" && p.studentId !== input.studentId) throw new ForbiddenError();

  // Serialise bookings per student (lesson numbering) and verify status.
  const student = await one<{ id: string; status: string; email: string | null }>(
    tx,
    `SELECT id, status, email FROM students WHERE id = $1 FOR UPDATE`,
    [input.studentId],
  );
  if (!student) throw new NotFoundError("Student");
  if (!["active", "lead"].includes(student.status)) throw new PolicyError("This student cannot book lessons.", "student_inactive");

  const minutes = Math.round((input.slot.end.getTime() - input.slot.start.getTime()) / 60000);
  if (minutes < 15) throw new ValidationError("Lesson is too short");

  let slot: Slot | null = input.slot;
  const staffOverride = input.overrideAvailability && isStaff(p);
  if (!staffOverride) {
    slot = await revalidateSlot(
      tx,
      ctx,
      { studentId: input.studentId, ignoreLessonIds: input.rescheduledFromId ? [input.rescheduledFromId] : [] },
      input.slot,
    );
    if (!slot) throw new ConflictError("This time slot is no longer available. Please pick another one.", "slot_taken");
  }

  const priceCents = isStaff(p) && input.priceCents !== undefined ? input.priceCents : priceForDuration(ctx, minutes);
  const createdBy = p.type === "user" ? p.actor.userId : null;
  // Insert; the exclusion constraints are the final, race-proof guard.
  const lesson = (await one<LessonRow>(
    tx,
    `INSERT INTO lessons (school_id, student_id, instructor_id, vehicle_id, start_time, end_time, status,
                          lesson_number, lesson_type, price_cents, currency, booked_via, created_by, notes, rescheduled_from_id)
     VALUES ($1,$2,$3,$4,$5,$6,'scheduled', 1, $7,$8,$9,$10,$11,$12,$13)
     RETURNING *`,
    [
      p.schoolId,
      input.studentId,
      slot.instructorId,
      slot.vehicleId,
      slot.start,
      slot.end,
      input.lessonType ?? "practical",
      priceCents,
      ctx.currency,
      input.bookedVia,
      createdBy,
      input.notes ?? null,
      input.rescheduledFromId ?? null,
    ],
  ))!;
  if (student.status === "lead") {
    await tx.query(`UPDATE students SET status = 'active' WHERE id = $1`, [student.id]);
  }
  await renumberStudentLessons(tx, input.studentId);
  await audit(tx, p, "lesson.booked", "lesson", lesson.id, { start: slot.start, instructor: slot.instructorId, via: input.bookedVia });

  if (!input.rescheduledFromId) {
    const snap = await lessonSnapshot(tx, lesson.id);
    await enqueueNotification(tx, {
      schoolId: p.schoolId,
      type: "lesson_booked",
      to: snap?.student_email,
      studentId: input.studentId,
      lessonId: lesson.id,
      payload: { lesson: snap },
      dedupeKey: `lesson_booked:${lesson.id}`,
    });
  }
  return (await one<LessonRow>(tx, `SELECT * FROM lessons WHERE id = $1`, [lesson.id]))!;
}

// ---------------------------------------------------------------------------
// Instructor operations
// ---------------------------------------------------------------------------

export async function confirmLesson(tx: Tx, p: Principal, lessonId: string) {
  const l = await lockLesson(tx, lessonId);
  assertLessonAccess(p, l, "operate");
  if (l.status !== "scheduled") throw new PolicyError("Only scheduled lessons can be confirmed.", "invalid_status");
  await tx.query(`UPDATE lessons SET status = 'confirmed' WHERE id = $1`, [lessonId]);
  await audit(tx, p, "lesson.confirmed", "lesson", lessonId);
}

export async function startLesson(tx: Tx, p: Principal, lessonId: string) {
  const l = await lockLesson(tx, lessonId);
  assertLessonAccess(p, l, "operate");
  if (!isInstructorOrStaff(p)) throw new ForbiddenError();
  if (!["scheduled", "confirmed"].includes(l.status)) throw new PolicyError("This lesson cannot be started.", "invalid_status");
  const now = await dbNow(tx);
  if (now.getTime() < l.start_time.getTime() - 30 * 60_000) {
    throw new PolicyError("A lesson can be started at most 30 minutes early.", "too_early");
  }
  await tx.query(`UPDATE lessons SET status = 'in_progress', started_at = now() WHERE id = $1`, [lessonId]);
  await audit(tx, p, "lesson.started", "lesson", lessonId);
}

export interface FeedbackInput {
  strengths?: string;
  weaknesses?: string;
  practiceItems?: string;
  nextFocus?: string;
  instructorNotes?: string;
  overallRating?: number;
  overallLevelId?: string | null;
  visibleToStudent?: boolean;
}

export async function upsertFeedback(tx: Tx, p: Principal, lesson: LessonRow, f: FeedbackInput) {
  await tx.query(
    `INSERT INTO lesson_feedback (school_id, lesson_id, student_id, instructor_id, overall_level_id, overall_rating,
                                  strengths, weaknesses, practice_items, next_focus, instructor_notes, visible_to_student)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,COALESCE($12,true))
     ON CONFLICT (lesson_id) DO UPDATE SET
       overall_level_id = EXCLUDED.overall_level_id, overall_rating = EXCLUDED.overall_rating,
       strengths = EXCLUDED.strengths, weaknesses = EXCLUDED.weaknesses, practice_items = EXCLUDED.practice_items,
       next_focus = EXCLUDED.next_focus, instructor_notes = EXCLUDED.instructor_notes,
       visible_to_student = EXCLUDED.visible_to_student`,
    [
      p.schoolId,
      lesson.id,
      lesson.student_id,
      lesson.instructor_id,
      f.overallLevelId ?? null,
      f.overallRating ?? null,
      f.strengths ?? null,
      f.weaknesses ?? null,
      f.practiceItems ?? null,
      f.nextFocus ?? null,
      f.instructorNotes ?? null,
      f.visibleToStudent ?? null,
    ],
  );
  await audit(tx, p, "lesson.feedback_saved", "lesson", lesson.id);
}

export interface CompleteLessonInput {
  feedback?: FeedbackInput;
  skills?: SkillUpdate[];
  newLevelId?: string | null;
  /** Override the school default (auto_payment_request). */
  paymentRequired?: boolean;
}

/**
 * Complete a lesson and (when payment applies) create the invoice + payment
 * and queue the payment-request e-mail — all in one transaction, so either
 * everything happens or nothing does.
 */
export async function completeLesson(tx: Tx, p: Principal, lessonId: string, input: CompleteLessonInput = {}) {
  const l = await lockLesson(tx, lessonId);
  assertLessonAccess(p, l, "operate");
  if (!isInstructorOrStaff(p)) throw new ForbiddenError();
  if (!["scheduled", "confirmed", "in_progress"].includes(l.status)) {
    throw new PolicyError(`A ${l.status} lesson cannot be completed.`, "invalid_status");
  }
  const now = await dbNow(tx);
  if (now.getTime() < l.start_time.getTime()) throw new PolicyError("A lesson cannot be completed before it starts.", "too_early");

  await tx.query(
    `UPDATE lessons SET status = 'completed', completed_at = now(), started_at = COALESCE(started_at, start_time) WHERE id = $1`,
    [lessonId],
  );
  if (input.feedback) await upsertFeedback(tx, p, l, input.feedback);
  if (input.skills?.length || input.newLevelId) {
    await applyProgressUpdate(tx, p, { studentId: l.student_id, lessonId, skills: input.skills ?? [], newLevelId: input.newLevelId ?? null });
  }

  const ctx = await loadSchoolContext(tx, p.schoolId);
  const paymentRequired = (input.paymentRequired ?? ctx.settings.auto_payment_request) && l.price_cents > 0;
  let payment: { id: string } | null = null;
  if (paymentRequired) payment = await createInvoiceAndPaymentForLesson(tx, p, ctx, l);

  await audit(tx, p, "lesson.completed", "lesson", lessonId, { payment_id: payment?.id ?? null });
  return { lessonId, paymentId: payment?.id ?? null };
}

export async function markNoShow(tx: Tx, p: Principal, lessonId: string, chargeFee = true) {
  const l = await lockLesson(tx, lessonId);
  assertLessonAccess(p, l, "operate");
  if (!isInstructorOrStaff(p)) throw new ForbiddenError();
  if (!["scheduled", "confirmed"].includes(l.status)) throw new PolicyError("Only upcoming lessons can be marked as no-show.", "invalid_status");
  const now = await dbNow(tx);
  if (now < l.start_time) throw new PolicyError("A lesson can only be marked no-show after it started.", "too_early");
  await tx.query(`UPDATE lessons SET status = 'no_show' WHERE id = $1`, [lessonId]);
  // A no-show is billed like the lesson itself when the school charges for it.
  if (chargeFee && l.price_cents > 0) {
    const ctx = await loadSchoolContext(tx, p.schoolId);
    await createInvoiceAndPaymentForLesson(tx, p, ctx, l);
  }
  await audit(tx, p, "lesson.no_show", "lesson", lessonId);
}

export async function cancelLesson(tx: Tx, p: Principal, lessonId: string, reason: string, opts: { waiveFee?: boolean } = {}) {
  if (!reason.trim()) throw new ValidationError("A cancellation reason is required.");
  const l = await lockLesson(tx, lessonId);
  const staffLike = isInstructorOrStaff(p);
  assertLessonAccess(p, l, staffLike ? "operate" : "student_change");
  const ctx = await loadSchoolContext(tx, p.schoolId);
  const now = await dbNow(tx);

  if (!staffLike) {
    // Students (portal or WhatsApp) must respect the notice period.
    const check = checkStudentCancellation({
      lessonStart: l.start_time,
      status: l.status,
      now,
      noticeHours: ctx.settings.min_cancellation_notice_hours,
      timezone: ctx.timezone,
    });
    if (!check.allowed) throw new PolicyError(check.message, check.code, { deadline: check.deadline });
  } else if (!["scheduled", "confirmed", "in_progress"].includes(l.status)) {
    throw new PolicyError(`A ${l.status} lesson cannot be cancelled.`, "invalid_status");
  }

  await tx.query(
    `UPDATE lessons SET status = 'cancelled', cancellation_reason = $2, cancelled_at = now(), cancelled_by = $3 WHERE id = $1`,
    [lessonId, reason, p.type === "user" ? p.actor.userId : null],
  );
  await renumberStudentLessons(tx, l.student_id);

  const late = isLateCancellation({
    lessonStart: l.start_time,
    now,
    noticeHours: ctx.settings.min_cancellation_notice_hours,
    timezone: ctx.timezone,
  });
  if (late && staffLike && !opts.waiveFee && ctx.settings.late_cancellation_fee_cents > 0) {
    await createCancellationFeeInvoice(tx, p, ctx, l);
  }

  const snap = await lessonSnapshot(tx, lessonId);
  await enqueueNotification(tx, {
    schoolId: p.schoolId,
    type: "lesson_cancelled",
    to: snap?.student_email,
    studentId: l.student_id,
    lessonId,
    payload: { lesson: snap, reason },
    dedupeKey: `lesson_cancelled:${lessonId}`,
  });
  await audit(tx, p, "lesson.cancelled", "lesson", lessonId, { reason, late });
}

// ---------------------------------------------------------------------------
// Rescheduling
// ---------------------------------------------------------------------------

/**
 * Move a lesson to a new slot: the original becomes 'rescheduled' and a new
 * lesson is created that points back to it. Students/agent are bound by the
 * notice rule (default 24h in the school's timezone); staff are not.
 */
export async function rescheduleLesson(
  tx: Tx,
  p: Principal,
  lessonId: string,
  slot: Slot,
  opts: { reason?: string; channel: "student_portal" | "whatsapp_agent" | "staff" },
) {
  const original = await lockLesson(tx, lessonId);
  const staffLike = isInstructorOrStaff(p);
  assertLessonAccess(p, original, staffLike ? "operate" : "student_change");
  const ctx = await loadSchoolContext(tx, p.schoolId);
  const now = await dbNow(tx);

  if (!staffLike) {
    const check = checkStudentReschedule({
      lessonStart: original.start_time,
      status: original.status,
      now,
      noticeHours: ctx.settings.min_reschedule_notice_hours,
      timezone: ctx.timezone,
    });
    if (!check.allowed) throw new PolicyError(check.message, check.code, { deadline: check.deadline });
  } else if (!["scheduled", "confirmed"].includes(original.status)) {
    throw new PolicyError(`A ${original.status} lesson cannot be rescheduled.`, "invalid_status");
  }

  // Keep the original duration.
  const durationMs = original.end_time.getTime() - original.start_time.getTime();
  if (slot.end.getTime() - slot.start.getTime() !== durationMs) throw new ValidationError("The new slot must have the same duration.");

  const requestedBy = p.type === "user" ? p.actor.userId : null;
  const request = (await one<{ id: string }>(
    tx,
    `INSERT INTO reschedule_requests (school_id, lesson_id, student_id, requested_by, channel, original_start, original_end,
                                      requested_start, requested_end, reason, status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'pending') RETURNING id`,
    [p.schoolId, lessonId, original.student_id, requestedBy, opts.channel, original.start_time, original.end_time, slot.start, slot.end, opts.reason ?? null],
  ))!;

  if (!staffLike && ctx.settings.reschedule_requires_approval) {
    // School reviews it; the slot is not held.
    const snap = await lessonSnapshot(tx, lessonId);
    await enqueueNotification(tx, {
      schoolId: p.schoolId,
      type: "reschedule_request_received",
      to: snap?.student_email,
      studentId: original.student_id,
      lessonId,
      payload: { lesson: snap, requested_start: slot.start, requested_end: slot.end },
    });
    await audit(tx, p, "lesson.reschedule_requested", "lesson", lessonId, { request_id: request.id });
    return { status: "pending_approval" as const, requestId: request.id, newLessonId: null };
  }

  const newLesson = await applyReschedule(tx, p, original, slot, opts.channel, !staffLike);
  await tx.query(
    `UPDATE reschedule_requests SET status = 'completed', new_lesson_id = $2, decided_at = now(), decided_by = $3 WHERE id = $1`,
    [request.id, newLesson.id, requestedBy],
  );
  return { status: "completed" as const, requestId: request.id, newLessonId: newLesson.id };
}

async function applyReschedule(tx: Tx, p: Principal, original: LessonRow, slot: Slot, channel: string, validateSlot: boolean) {
  // Free the old time first, so the new slot may overlap it (e.g. moving by 30 minutes).
  await tx.query(`UPDATE lessons SET status = 'rescheduled' WHERE id = $1`, [original.id]);
  const newLesson = await bookLesson(tx, p, {
    studentId: original.student_id,
    slot,
    lessonType: original.lesson_type as BookLessonInput["lessonType"],
    priceCents: original.price_cents,
    bookedVia: channel === "staff" ? "staff" : channel === "whatsapp_agent" ? "whatsapp_agent" : "student_portal",
    overrideAvailability: !validateSlot,
    rescheduledFromId: original.id,
  });
  // Price is preserved for student-initiated moves too.
  await tx.query(`UPDATE lessons SET price_cents = $2 WHERE id = $1`, [newLesson.id, original.price_cents]);

  const snapOld = { start_time: original.start_time, end_time: original.end_time };
  const snap = await lessonSnapshot(tx, newLesson.id);
  await enqueueNotification(tx, {
    schoolId: p.schoolId,
    type: "lesson_rescheduled",
    to: snap?.student_email,
    studentId: original.student_id,
    lessonId: newLesson.id,
    payload: { lesson: snap, previous: snapOld },
    dedupeKey: `lesson_rescheduled:${newLesson.id}`,
  });
  await audit(tx, p, "lesson.rescheduled", "lesson", original.id, { new_lesson_id: newLesson.id, new_start: slot.start });
  return newLesson;
}

/** Staff approve / reject a pending student reschedule request. */
export async function decideRescheduleRequest(tx: Tx, p: Principal, requestId: string, approve: boolean) {
  if (!isStaff(p)) throw new ForbiddenError();
  const req = await one<{ id: string; lesson_id: string; status: string; requested_start: Date; requested_end: Date }>(
    tx,
    `SELECT * FROM reschedule_requests WHERE id = $1 FOR UPDATE`,
    [requestId],
  );
  if (!req) throw new NotFoundError("Reschedule request");
  if (req.status !== "pending") throw new PolicyError("This request was already handled.", "invalid_status");
  const decidedBy = p.type === "user" ? p.actor.userId : null;
  if (!approve) {
    await tx.query(`UPDATE reschedule_requests SET status = 'rejected', decided_at = now(), decided_by = $2 WHERE id = $1`, [requestId, decidedBy]);
    await audit(tx, p, "reschedule_request.rejected", "reschedule_request", requestId);
    return null;
  }
  const original = await lockLesson(tx, req.lesson_id);
  const ctx = await loadSchoolContext(tx, p.schoolId);
  // Offer the same instructor first; any free compatible instructor otherwise.
  const candidates = await searchSlots(tx, ctx, {
    studentId: original.student_id,
    from: req.requested_start,
    to: req.requested_end,
    durationMinutes: Math.round((req.requested_end.getTime() - req.requested_start.getTime()) / 60000),
    ignoreLessonIds: [original.id],
    ignoreLeadTime: true,
  });
  const slot =
    candidates.find((s) => s.instructorId === original.instructor_id && s.start.getTime() === req.requested_start.getTime()) ??
    candidates.find((s) => s.start.getTime() === req.requested_start.getTime());
  if (!slot) throw new ConflictError("The requested time is no longer available.", "slot_taken");
  const newLesson = await applyReschedule(tx, p, original, slot, "staff", false);
  await tx.query(
    `UPDATE reschedule_requests SET status = 'completed', new_lesson_id = $2, decided_at = now(), decided_by = $3 WHERE id = $1`,
    [requestId, newLesson.id, decidedBy],
  );
  return newLesson.id;
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

export interface CalendarLesson {
  id: string;
  start_time: Date;
  end_time: Date;
  status: LessonStatus;
  lesson_number: number;
  payment_status: string;
  student_id: string;
  student_name: string;
  student_phone: string | null;
  level_name: string | null;
  level_position: number | null;
  instructor_id: string;
  instructor_name: string;
  instructor_color: string | null;
  vehicle: string | null;
  registration_number: string | null;
}

export async function listCalendarLessons(tx: Tx, args: { from: Date; to: Date; instructorId?: string | null; studentId?: string | null }) {
  return many<CalendarLesson>(
    tx,
    `SELECT l.id, l.start_time, l.end_time, l.status, l.lesson_number, l.payment_status,
            s.id AS student_id, s.first_name || ' ' || s.last_name AS student_name, s.phone AS student_phone,
            ld.name AS level_name, ld.position AS level_position,
            i.id AS instructor_id, i.first_name || ' ' || i.last_name AS instructor_name, i.color AS instructor_color,
            CASE WHEN v.id IS NULL THEN NULL ELSE v.brand || ' ' || v.model END AS vehicle, v.registration_number
       FROM lessons l
       JOIN students s ON s.id = l.student_id
       JOIN instructors i ON i.id = l.instructor_id
       LEFT JOIN vehicles v ON v.id = l.vehicle_id
       LEFT JOIN level_definitions ld ON ld.id = s.current_level_id
      WHERE l.start_time < $2 AND l.end_time > $1
        AND l.status <> 'rescheduled'
        AND ($3::uuid IS NULL OR l.instructor_id = $3)
        AND ($4::uuid IS NULL OR l.student_id = $4)
      ORDER BY l.start_time`,
    [args.from, args.to, args.instructorId ?? null, args.studentId ?? null],
  );
}

export function calendarRange(view: "day" | "week" | "month", anchorIso: string, zone: string) {
  const anchor = DateTime.fromISO(anchorIso, { zone });
  const base = anchor.isValid ? anchor : DateTime.now().setZone(zone);
  const start =
    view === "day" ? base.startOf("day") : view === "week" ? base.startOf("week") : base.startOf("month").startOf("week");
  const end = view === "day" ? start.plus({ days: 1 }) : view === "week" ? start.plus({ weeks: 1 }) : base.endOf("month").endOf("week").plus({ milliseconds: 1 });
  return { start, end, anchor: base };
}
