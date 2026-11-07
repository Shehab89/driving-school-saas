/**
 * CBR exams. The school reserves exams in CBR's own portal (TOP, later the
 * Opleidersportaal) and records them here: product, date, exam centre,
 * reservation number and result. DriveDesk then shows them in the calendar,
 * to the student, and checks what CBR needs first (see lib/cbr.ts).
 *
 * There is no live connection with CBR yet: that needs the school's own CBR
 * login (TOP web service) or DriveDesk's registration as a software supplier
 * for CBR's coming Opleiders-API.
 */
import { z } from "zod";
import { many, one, type Tx } from "@/lib/db";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "@/lib/errors";
import { can } from "@/lib/rbac";
import { CBR_EXAM_DAY_MINUTES, CBR_HEALTH, CBR_PRODUCTS, CBR_STATUSES, isPractical, passRate, type CbrHealth, type CbrProduct, type CbrStatus } from "@/lib/cbr";
import type { Principal } from "../principal";
import { audit } from "./audit";
import { bookLesson } from "./lessons";

/** The exam-day booking starts this long before the exam itself (pick-up and warm-up drive). */
export const EXAM_DAY_LEAD_MINUTES = 60;

export function examDayWindow(product: CbrProduct, examAt: Date) {
  const start = new Date(examAt.getTime() - EXAM_DAY_LEAD_MINUTES * 60_000);
  return { start, end: new Date(start.getTime() + CBR_EXAM_DAY_MINUTES[product] * 60_000) };
}

/**
 * Book car + instructor for the exam day in the calendar. Checks first, so the
 * school is told exactly who is busy; the database still refuses any overlap
 * if two bookings race. The whole save is rolled back when the time is taken.
 */
async function bookExamDay(tx: Tx, p: Principal, examId: string, studentId: string, product: CbrProduct, examAt: Date, instructorId: string, location: string | null) {
  const ins = await one<{ id: string; default_vehicle_id: string | null; name: string }>(
    tx,
    `SELECT id, default_vehicle_id, first_name || ' ' || last_name AS name FROM instructors WHERE id = $1 AND status = 'active'`,
    [instructorId],
  );
  if (!ins) throw new NotFoundError("Instructor");
  const { start, end } = examDayWindow(product, examAt);
  const clash = await one<{ start_time: Date; end_time: Date; who: "instructor" | "vehicle" | "student"; student: string }>(
    tx,
    `SELECT l.start_time, l.end_time, s.first_name || ' ' || s.last_name AS student,
            CASE WHEN l.instructor_id = $3 THEN 'instructor' WHEN l.student_id = $5 THEN 'student' ELSE 'vehicle' END AS who
       FROM lessons l JOIN students s ON s.id = l.student_id
      WHERE l.status NOT IN ('cancelled','rescheduled')
        AND tstzrange(l.start_time, l.end_time) && tstzrange($1, $2)
        AND (l.instructor_id = $3 OR ($4::uuid IS NOT NULL AND l.vehicle_id = $4) OR l.student_id = $5)
      ORDER BY l.start_time LIMIT 1`,
    [start, end, ins.id, ins.default_vehicle_id, studentId],
  );
  if (clash) {
    const hm = (d: Date) => d.toLocaleTimeString("nl-NL", { hour: "2-digit", minute: "2-digit", timeZone: "Europe/Amsterdam" });
    const when = `${hm(clash.start_time)}–${hm(clash.end_time)}`;
    throw new ConflictError(`That time is already booked: ${clash.student}, ${when}. Nothing was saved.`, "exam_time_taken", {
      who: clash.who, instructor: ins.name, student: clash.student, when, from: clash.start_time.toISOString(), to: clash.end_time.toISOString(),
    });
  }
  const lesson = await bookLesson(tx, p, {
    studentId,
    slot: { start, end, instructorId: ins.id, vehicleId: ins.default_vehicle_id },
    lessonType: "exam",
    overrideAvailability: true, // CBR sets the exam time; only real overlaps are refused
    bookedVia: "staff",
    notes: ["CBR", location].filter(Boolean).join(" · "),
  });
  await tx.query(`UPDATE cbr_exams SET lesson_id = $2 WHERE id = $1`, [examId, lesson.id]);
  return lesson.id;
}

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use a date like 2026-05-31");
const optDate = z.union([isoDate, z.literal("")]).optional().transform((v) => v || null);
const optText = (max: number) => z.string().trim().max(max).optional().transform((v) => v || null);

export const cbrExamSchema = z.object({
  id: z.string().uuid().optional(),
  studentId: z.string().uuid(),
  product: z.enum(CBR_PRODUCTS),
  status: z.enum(CBR_STATUSES).default("reserved"),
  examAt: z.date().nullable().default(null),
  location: optText(120),
  reservationNumber: optText(40),
  feeCents: z.number().int().min(0).max(1_000_000).nullable().default(null),
  resultNotes: optText(2000),
  lessonId: z.string().uuid().nullable().optional(),
  /** Also put the exam day (car + instructor) in the calendar. Refused when that time is already taken. */
  bookCalendar: z.object({ instructorId: z.string().uuid() }).nullable().optional(),
});
export type CbrExamInput = z.input<typeof cbrExamSchema>;

export const cbrStudentSchema = z.object({
  theoryPassedOn: optDate,
  health: z.enum(CBR_HEALTH).default("unknown"),
  authorizedOn: optDate,
});

export interface CbrExam {
  id: string;
  student_id: string;
  product: CbrProduct;
  status: CbrStatus;
  exam_at: Date | null;
  location: string | null;
  reservation_number: string | null;
  fee_cents: number | null;
  lesson_id: string | null;
  result_notes: string | null;
  created_at: Date;
}

export interface CbrStudentRow { cbr_theory_passed_on: string | null; cbr_health_status: CbrHealth; cbr_authorized_on: string | null }

const COLS = `e.id, e.student_id, e.product, e.status, e.exam_at, e.location, e.reservation_number, e.fee_cents, e.lesson_id, e.result_notes, e.created_at`;

function assertStaff(p: Principal) {
  if (p.type === "system") return;
  if (p.type !== "user" || !can(p.actor.role, "lessons:write_all")) throw new ForbiddenError();
}

/** Creates or updates a CBR exam record. */
export async function saveCbrExam(tx: Tx, p: Principal, raw: CbrExamInput) {
  assertStaff(p);
  const input = cbrExamSchema.parse(raw);
  if (!["to_reserve", "cancelled"].includes(input.status) && !input.examAt) throw new ValidationError("Enter the exam date and time.");
  const student = await one<{ id: string }>(tx, `SELECT id FROM students WHERE id = $1`, [input.studentId]);
  if (!student) throw new NotFoundError("Student");
  if (input.lessonId) {
    const l = await one<{ id: string }>(tx, `SELECT id FROM lessons WHERE id = $1 AND student_id = $2`, [input.lessonId, input.studentId]);
    if (!l) throw new NotFoundError("Lesson");
  }
  const vals = [input.product, input.status, input.examAt, input.location, input.reservationNumber, input.feeCents, input.resultNotes];
  let id = input.id;
  if (id) {
    const row = await one<{ id: string }>(
      tx,
      `UPDATE cbr_exams SET product = $3, status = $4, exam_at = $5, location = $6, reservation_number = $7, fee_cents = $8, result_notes = $9,
              lesson_id = CASE WHEN $10::boolean THEN $11::uuid ELSE lesson_id END
        WHERE id = $1 AND student_id = $2 RETURNING id`,
      [id, input.studentId, ...vals, input.lessonId !== undefined, input.lessonId ?? null],
    );
    if (!row) throw new NotFoundError("Exam");
  } else {
    const row = await one<{ id: string }>(
      tx,
      `INSERT INTO cbr_exams (school_id, student_id, product, status, exam_at, location, reservation_number, fee_cents, result_notes, lesson_id, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
      [p.schoolId, input.studentId, ...vals, input.lessonId ?? null, p.type === "user" ? p.actor.userId : null],
    );
    id = row!.id;
  }
  if (input.bookCalendar && input.examAt && input.status === "reserved" && isPractical(input.product)) {
    const has = await one<{ lesson_id: string | null }>(tx, `SELECT lesson_id FROM cbr_exams WHERE id = $1`, [id]);
    if (!has?.lesson_id) await bookExamDay(tx, p, id!, input.studentId, input.product, input.examAt, input.bookCalendar.instructorId, input.location);
  }
  await audit(tx, p, input.id ? "cbr_exam.updated" : "cbr_exam.created", "cbr_exam", id, { product: input.product, status: input.status });
  return id;
}

/** Removes a record that was entered by mistake (a cancelled exam should be kept as "cancelled"). */
export async function deleteCbrExam(tx: Tx, p: Principal, id: string) {
  assertStaff(p);
  const row = await one<{ id: string }>(tx, `DELETE FROM cbr_exams WHERE id = $1 RETURNING id`, [id]);
  if (!row) throw new NotFoundError("Exam");
  await audit(tx, p, "cbr_exam.deleted", "cbr_exam", id);
}

/** Saves what CBR needs from the student: theory passed on, health declaration, authorisation of the school. */
export async function saveCbrStudent(tx: Tx, p: Principal, studentId: string, raw: z.input<typeof cbrStudentSchema>) {
  if (p.type !== "system" && (p.type !== "user" || !can(p.actor.role, "students:write"))) throw new ForbiddenError();
  const input = cbrStudentSchema.parse(raw);
  const row = await one<{ id: string }>(
    tx,
    `UPDATE students SET cbr_theory_passed_on = $2, cbr_health_status = $3, cbr_authorized_on = $4 WHERE id = $1 RETURNING id`,
    [studentId, input.theoryPassedOn, input.health, input.authorizedOn],
  );
  if (!row) throw new NotFoundError("Student");
  await audit(tx, p, "student.cbr_updated", "student", studentId, { health: input.health, theory: !!input.theoryPassedOn, authorized: !!input.authorizedOn });
}

export async function cbrStudent(tx: Tx, studentId: string) {
  return one<CbrStudentRow>(tx, `SELECT cbr_theory_passed_on::text, cbr_health_status, cbr_authorized_on::text FROM students WHERE id = $1`, [studentId]);
}

/** All CBR exams of one student, newest first. */
export async function studentCbrExams(tx: Tx, studentId: string) {
  return many<CbrExam>(tx, `SELECT ${COLS} FROM cbr_exams e WHERE e.student_id = $1 ORDER BY e.exam_at DESC NULLS FIRST, e.created_at DESC`, [studentId]);
}

/** The student's next exam that is still open (to reserve or reserved), for the student app. */
export async function nextCbrExam(tx: Tx, studentId: string) {
  return one<CbrExam>(
    tx,
    `SELECT ${COLS} FROM cbr_exams e WHERE e.student_id = $1 AND e.status IN ('to_reserve','reserved') AND (e.exam_at IS NULL OR e.exam_at > now() - interval '6 hours')
      ORDER BY e.exam_at NULLS LAST LIMIT 1`,
    [studentId],
  );
}

export type SchoolCbrExam = CbrExam & { student_name: string; student_number: string } & CbrStudentRow;

/** The school's exam overview: open (to reserve / reserved) and results of the last 12 months, plus the practical pass rate. */
export async function schoolCbrOverview(tx: Tx, p: Principal) {
  if (p.type !== "system" && (p.type !== "user" || !can(p.actor.role, "students:read_all"))) throw new ForbiddenError();
  const rows = await many<SchoolCbrExam>(
    tx,
    `SELECT ${COLS}, s.first_name || ' ' || s.last_name AS student_name, s.student_number,
            s.cbr_theory_passed_on::text, s.cbr_health_status, s.cbr_authorized_on::text
       FROM cbr_exams e JOIN students s ON s.id = e.student_id
      WHERE e.status IN ('to_reserve','reserved') OR e.exam_at > now() - interval '12 months'
      ORDER BY e.exam_at NULLS FIRST`,
  );
  const open = rows.filter((r) => r.status === "to_reserve" || r.status === "reserved");
  const results = rows.filter((r) => !open.includes(r)).reverse();
  return { open, results, pass: passRate(results) };
}
