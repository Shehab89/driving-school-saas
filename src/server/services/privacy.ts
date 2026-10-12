/**
 * GDPR: data export (art. 15/20), erasure (art. 17) and storage limitation.
 *
 * Erasure anonymises rather than deletes: lessons, invoices and payments stay
 * (instructor schedules and the 7-year tax retention need them), but every
 * field that identifies the person is cleared. Issued invoices keep the
 * billed name, which Dutch tax law requires (see migration 010).
 */
import { many, one, withPlatform, withTenant, type Tx } from "@/lib/db";
import { ForbiddenError, NotFoundError, PolicyError } from "@/lib/errors";
import { can } from "@/lib/rbac";
import { log } from "@/lib/log";
import type { Principal } from "../principal";
import { audit } from "./audit";

/** Everything the school holds about one student, as plain JSON. */
export async function exportStudentData(tx: Tx, p: Principal, studentId: string) {
  const own = p.type === "user" && p.actor.role === "student" && p.actor.studentId === studentId;
  if (!own && !(p.type === "user" && can(p.actor.role, "students:read_all"))) throw new ForbiddenError();
  const student = await one<Record<string, unknown> & { user_id: string | null; phone_e164: string | null }>(
    tx,
    `SELECT s.id, s.student_number, s.first_name, s.last_name, s.email, s.phone, s.phone_e164, s.date_of_birth, s.license_category,
            s.preferred_transmission, s.status, s.source, s.created_at, s.notification_prefs, s.whatsapp_opt_in_at, s.whatsapp_opt_out_at,
            s.user_id, ld.name AS current_level, s.level_confirmed
       FROM students s LEFT JOIN level_definitions ld ON ld.id = s.current_level_id WHERE s.id = $1`,
    [studentId],
  );
  if (!student) throw new NotFoundError("Student");
  const q = (sql: string, params: unknown[] = [studentId]) => many(tx, sql, params);
  const data = {
    exported_at: new Date().toISOString(),
    school: await one(tx, `SELECT name, email, phone, address FROM schools WHERE id = $1`, [p.schoolId]),
    student,
    account: student.user_id ? await one(tx, `SELECT email, status, created_at, last_login_at FROM users WHERE id = $1`, [student.user_id]) : null,
    availability: await q(`SELECT weekday, start_time, end_time FROM student_availability WHERE student_id = $1 ORDER BY weekday`),
    lessons: await q(
      `SELECT l.lesson_number, l.start_time, l.end_time, l.status, l.payment_status, l.price_cents, i.first_name AS instructor
         FROM lessons l JOIN instructors i ON i.id = l.instructor_id WHERE l.student_id = $1 ORDER BY l.start_time`,
    ),
    // instructor_notes are internal notes about the student and are personal data too.
    feedback: await q(
      `SELECT l.lesson_number, f.strengths, f.weaknesses, f.practice_items, f.next_focus, f.instructor_notes, f.created_at
         FROM lesson_feedback f JOIN lessons l ON l.id = f.lesson_id WHERE f.student_id = $1 ORDER BY f.created_at`,
    ),
    skill_progress: await q(`SELECT sk.name AS skill, sp.status, sp.updated_at FROM student_skill_progress sp JOIN skills sk ON sk.id = sp.skill_id WHERE sp.student_id = $1`),
    level_history: await q(`SELECT h.created_at, ld.name AS level, h.source, h.reason FROM student_level_history h JOIN level_definitions ld ON ld.id = h.to_level_id WHERE h.student_id = $1 ORDER BY h.created_at`),
    assessments: await q(`SELECT created_at, source, answers, suggested_band, rationale, status FROM assessments WHERE student_id = $1 ORDER BY created_at`),
    reschedule_requests: await q(`SELECT created_at, channel, reason, status FROM reschedule_requests WHERE student_id = $1 ORDER BY created_at`),
    invoices: await q(
      `SELECT invoice_number, issued_at, due_date, status, subtotal_cents, tax_cents, total_cents, currency, bill_to_name FROM invoices WHERE student_id = $1 ORDER BY issued_at`,
    ),
    payments: await q(`SELECT reference, amount_cents, currency, status, due_date, paid_at, provider FROM payments WHERE student_id = $1 ORDER BY created_at`),
    lesson_credits: await q(`SELECT created_at, delta, reason, note FROM student_credit_ledger WHERE student_id = $1 ORDER BY created_at`),
    messages_sent: await q(
      `SELECT created_at, type, channel, to_address, status, sent_at FROM notifications WHERE recipient_student_id = $1 ORDER BY created_at`,
    ),
    whatsapp: student.phone_e164
      ? await q(
          `SELECT m.created_at, m.direction, m.sender, m.body FROM whatsapp_messages m JOIN whatsapp_conversations c ON c.id = m.conversation_id
            WHERE c.student_id = $1 OR c.wa_phone_e164 = $2 ORDER BY m.created_at`,
          [studentId, student.phone_e164],
        )
      : [],
  };
  await audit(tx, p, "student.data_exported", "student", studentId, {});
  return data;
}

/**
 * Erase a student's personal data. Refused while lessons are still planned or
 * money is still open, so nothing is lost that the school still needs.
 */
export async function eraseStudent(tx: Tx, p: Principal, studentId: string, reason: string) {
  if (p.type === "user" ? !can(p.actor.role, "students:erase") : p.type !== "system") throw new ForbiddenError();
  if (p.type === "user" && !reason.trim()) throw new PolicyError("Give a reason (for example: request by the student on a date).", "reason_required");
  const s = await one<{ id: string; user_id: string | null; phone_e164: string | null; erased_at: Date | null }>(
    tx,
    `SELECT id, user_id, phone_e164, erased_at FROM students WHERE id = $1 FOR UPDATE`,
    [studentId],
  );
  if (!s) throw new NotFoundError("Student");
  if (s.erased_at) return { alreadyErased: true };
  const upcoming = await one<{ n: number }>(tx, `SELECT count(*)::int AS n FROM lessons WHERE student_id = $1 AND status IN ('scheduled','confirmed','in_progress') AND end_time > now()`, [studentId]);
  if (upcoming!.n > 0) throw new PolicyError(`Cancel the ${upcoming!.n} planned lesson(s) first.`, "has_upcoming_lessons");
  const open = await one<{ n: number }>(tx, `SELECT count(*)::int AS n FROM payments WHERE student_id = $1 AND status IN ('pending','overdue','failed','disputed')`, [studentId]);
  if (open!.n > 0) throw new PolicyError(`Settle or cancel the ${open!.n} open payment(s) first.`, "has_open_payments");

  // Profile: keep only the student number (needed to match invoices) and non-identifying fields.
  await tx.query(
    `UPDATE students SET first_name = 'Erased', last_name = 'student', email = NULL, phone = NULL, phone_e164 = NULL, date_of_birth = NULL,
            notes = NULL, notification_prefs = '{}'::jsonb, whatsapp_opt_in_at = NULL, whatsapp_opt_out_at = NULL,
            status = 'archived', erased_at = now(), user_id = NULL
      WHERE id = $1`,
    [studentId],
  );
  await tx.query(`DELETE FROM student_availability WHERE student_id = $1`, [studentId]);
  await tx.query(
    `UPDATE lesson_feedback SET strengths = NULL, weaknesses = NULL, practice_items = NULL, next_focus = NULL, instructor_notes = NULL WHERE student_id = $1`,
    [studentId],
  );
  await tx.query(`UPDATE assessments SET answers = '{}'::jsonb, rationale = NULL, override_reason = NULL WHERE student_id = $1`, [studentId]);
  await tx.query(`UPDATE reschedule_requests SET reason = NULL WHERE student_id = $1`, [studentId]);
  await tx.query(`UPDATE student_level_history SET reason = NULL WHERE student_id = $1`, [studentId]);
  await tx.query(`UPDATE notifications SET to_address = 'erased', payload = '{}'::jsonb WHERE recipient_student_id = $1`, [studentId]);
  // WhatsApp chats with this person (linked, or from the same number) go entirely.
  await tx.query(`DELETE FROM whatsapp_conversations WHERE student_id = $1 OR ($2::text IS NOT NULL AND wa_phone_e164 = $2)`, [studentId, s.phone_e164]);
  if (s.user_id) {
    await tx.query(
      `UPDATE users SET email = 'erased-' || id || '@invalid.example', phone = NULL, password_hash = NULL, auth_subject = NULL,
              status = 'disabled', token_version = token_version + 1, notification_prefs = '{}'::jsonb
        WHERE id = $1`,
      [s.user_id],
    );
    await tx.query(`DELETE FROM user_invites WHERE user_id = $1`, [s.user_id]);
  }
  await tx.query(`SELECT scrub_audit_details($1::uuid[])`, [[studentId, s.user_id].filter(Boolean)]);
  await audit(tx, p, "student.erased", "student", studentId, { reason: reason.trim() || "retention period ended" });
  return { alreadyErased: false };
}

/**
 * Nightly storage-limitation job:
 *  - erase students archived longer than the school's retention period
 *    (skipped while they still have open payments);
 *  - delete sent-message records after 13 months and WhatsApp chats after 24 months;
 *  - delete used or expired activation/reset links after 30 days.
 */
export async function applyRetention() {
  const due = await withPlatform((tx) =>
    many<{ id: string; school_id: string }>(
      tx,
      `SELECT s.id, s.school_id FROM students s JOIN school_settings ss ON ss.school_id = s.school_id
        WHERE s.status = 'archived' AND s.erased_at IS NULL AND ss.retention_months IS NOT NULL
          AND s.archived_at < now() - make_interval(months => ss.retention_months)
          AND NOT EXISTS (SELECT 1 FROM payments p WHERE p.student_id = s.id AND p.status IN ('pending','overdue','failed','disputed'))
        LIMIT 200`,
    ),
  );
  let erased = 0;
  for (const s of due) {
    try {
      await withTenant(s.school_id, (tx) => eraseStudent(tx, { type: "system", schoolId: s.school_id }, s.id, ""));
      erased++;
    } catch (err) {
      log.warn("retention.erase_skipped", { studentId: s.id, err: err instanceof Error ? err.message : String(err) });
    }
  }
  const pruned = await withPlatform(async (tx) => ({
    notifications: (await tx.query(`DELETE FROM notifications WHERE created_at < now() - interval '13 months' AND status NOT IN ('queued','sending')`)).rowCount ?? 0,
    whatsapp: (await tx.query(`DELETE FROM whatsapp_messages WHERE created_at < now() - interval '24 months'`)).rowCount ?? 0,
    invites: (await tx.query(`DELETE FROM user_invites WHERE (used_at IS NOT NULL OR expires_at < now()) AND created_at < now() - interval '30 days'`)).rowCount ?? 0,
  }));
  return { erased, ...pruned };
}
