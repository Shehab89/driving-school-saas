/**
 * Synthetic demo data. Deterministic (seeded RNG) and relative to "now", so
 * every run gives the same story around the current date:
 *   - ABC Driving School (Amsterdam): 3 instructors, 4 cars, 30 students in
 *     Dutch, Arabic and English, ~5 months of lesson history with feedback,
 *     skills, levels, invoices and payments (paid / pending / overdue),
 *     no-shows, cancellations, reschedules, upcoming lessons, WhatsApp chats,
 *     AI assessments to review.
 *   - Rijschool Noord (Rotterdam): a one-person school, to show tenancy.
 * Everything goes through the real services (booking rules, billing, audit),
 * except that past lessons are inserted directly (you cannot book the past).
 *
 *   npm run db:seed          # SEED_PASSWORD overrides the demo password
 */
import { DateTime } from "luxon";
import { closePools, many, one, withPlatform, withTenant } from "../src/lib/db";
import { encryptSecret, hashPassword } from "../src/lib/crypto";
import type { SchoolActor } from "../src/lib/rbac";
import type { Principal } from "../src/server/principal";
import { createSchool } from "../src/server/services/schools";
import { addAvailabilityException, addAvailabilityRule, createInstructor, createVehicle, makeOwnerAnInstructor } from "../src/server/services/staff";
import { createStudent } from "../src/server/services/students";
import { bookLesson, cancelLesson, completeLesson, markNoShow, renumberStudentLessons, rescheduleLesson } from "../src/server/services/lessons";
import { applyProviderEvent, recordManualPayment } from "../src/server/services/billing";
import { createAssessment, reviewAssessment } from "../src/server/services/assessments";
import { loadSchoolContext, searchSlots } from "../src/server/scheduling/loader";
import { markOverduePayments } from "../src/server/jobs";
import { CHATS, FEEDBACK, HOURS, INSTRUCTORS, STUDENTS, VEHICLES, type Band, type Lang, type PersonSeed } from "./seed-data";

const PASSWORD = process.env.SEED_PASSWORD ?? "demo-password-123";
const ZONE = "Europe/Amsterdam";

// ---- deterministic randomness ------------------------------------------------
let state = 20260925;
function rand() {
  state |= 0;
  state = (state + 0x6d2b79f5) | 0;
  let t = Math.imul(state ^ (state >>> 15), 1 | state);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
const int = (a: number, b: number) => a + Math.floor(rand() * (b - a + 1));
const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)]!;
const chance = (p: number) => rand() < p;
const slug = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z]/g, "");

function band(lessonIndex: number): Band {
  return lessonIndex <= 5 ? "early" : lessonIndex <= 13 ? "mid" : "late";
}

// ---- helpers -----------------------------------------------------------------
type InstructorKey = keyof typeof INSTRUCTORS;
interface Ctx {
  schoolId: string;
  sys: Principal;
  owner: Principal;
  instructorIds: Record<string, string>;
  vehicleIds: Record<string, string>;
}

/** Occupancy so generated past lessons never overlap (the DB would reject them anyway). */
const busy = new Set<string>();
const key = (what: string, id: string, t: DateTime) => `${what}:${id}:${t.toISO()}`;

function instructorFor(p: PersonSeed, i: number): InstructorKey {
  if (p.instructor) return p.instructor;
  if (p.transmission === "automatic") return "sanne";
  if (p.lang === "ar") return "fatima";
  return i % 3 === 0 ? "fatima" : "john";
}

async function activateUsers(schoolId: string, hash: string) {
  await withTenant(schoolId, (tx) => tx.query(`UPDATE users SET password_hash = $1, status = 'active'`, [hash]));
}

// ---- main ----------------------------------------------------------------------
async function main() {
  const existing = await withPlatform((tx) => one(tx, `SELECT 1 FROM schools WHERE slug = 'abc-driving'`));
  if (existing) {
    console.log("Demo data already present (school 'abc-driving'). Use a fresh database to reseed.");
    return;
  }
  const hash = await hashPassword(PASSWORD);
  const now = DateTime.now().setZone(ZONE);

  await withPlatform((tx) =>
    tx.query(`INSERT INTO users (school_id, role, email, password_hash, status, locale) VALUES (NULL,'saas_admin','admin@platform.test',$1,'active','en') ON CONFLICT DO NOTHING`, [hash]),
  );

  // ---------------------------------------------------------------- school A
  const school = await createSchool(
    { name: "ABC Driving School", slug: "abc-driving", timezone: ZONE, currency: "EUR", ownerEmail: "owner@abc.test", ownerName: "Olivia", email: "hello@abc.test", phone: "+31 20 123 4567", address: "Damrak 1, 1012 LG Amsterdam", planCode: "team" },
    null,
  );
  const schoolId = school.id;
  const sys: Principal = { type: "system", schoolId };
  await activateUsers(schoolId, hash);
  const ownerRow = (await withTenant(schoolId, (tx) => one<{ id: string }>(tx, `SELECT id FROM users WHERE role = 'school_owner'`)))!;
  const ownerActor: SchoolActor = { userId: ownerRow.id, role: "school_owner", schoolId, email: "owner@abc.test", instructorId: null, studentId: null };
  const owner: Principal = { type: "user", schoolId, actor: ownerActor };

  const ctx: Ctx = { schoolId, sys, owner, instructorIds: {}, vehicleIds: {} };
  await withTenant(schoolId, async (tx) => {
    await tx.query(
      `UPDATE school_settings SET late_cancellation_fee_cents = 2500, min_booking_lead_hours = 12, buffer_minutes = 0,
              school_info_for_agent = $1`,
      [
        "Lesson 60 min €55. Package: 10 lessons €520. Exam (CBR) fee €150, exam lesson 90 min €110. Pick-up from home (Amsterdam) or Amsterdam Centraal. Lessons in Dutch, English and Arabic. Theory course not offered; we recommend online theory courses.",
      ],
    );
    await tx.query(`UPDATE users SET locale = 'en' WHERE role = 'school_owner'`);
    await tx.query(`INSERT INTO school_closures (school_id, starts_on, ends_on, reason) VALUES ($1, $2, $3, 'Christmas')`, [schoolId, `${now.year}-12-25`, `${now.year}-12-26`]);
    for (const v of VEHICLES) {
      ctx.vehicleIds[v.reg] = (await createVehicle(tx, sys, { registrationNumber: v.reg, brand: v.brand, model: v.model, transmission: v.transmission })).id;
    }
    for (const [k, ins] of Object.entries(INSTRUCTORS)) {
      const id = (await createInstructor(tx, sys, { firstName: ins.first, lastName: ins.last, email: ins.email, phone: ins.phone, defaultVehicleId: ctx.vehicleIds[ins.car], color: ins.color })).id;
      ctx.instructorIds[k] = id;
      await tx.query(`UPDATE users SET locale = $2 WHERE id = (SELECT user_id FROM instructors WHERE id = $1)`, [id, ins.lang]);
      for (const [weekday, start, end] of HOURS[k as InstructorKey]) {
        await addAvailabilityRule(tx, sys, { instructorId: id, isRecurring: true, weekday, start, end });
      }
    }
    // Fatima is on holiday for three days in ten days; Sanne adds an extra Saturday morning.
    const holiday = now.plus({ days: 10 }).startOf("day");
    await addAvailabilityException(tx, sys, { instructorId: ctx.instructorIds.fatima!, kind: "unavailable", startsAt: holiday.toJSDate(), endsAt: holiday.plus({ days: 3 }).toJSDate(), reason: "Holiday" });
    const sat = now.plus({ weeks: 1 }).set({ weekday: 6, hour: 9, minute: 0, second: 0, millisecond: 0 });
    await addAvailabilityException(tx, sys, { instructorId: ctx.instructorIds.sanne!, kind: "available", startsAt: sat.toJSDate(), endsAt: sat.plus({ hours: 4 }).toJSDate(), reason: "Extra exam practice" });
  });
  await activateUsers(schoolId, hash);

  // Students
  const studentIds = new Map<string, string>();
  const studentActors = new Map<string, SchoolActor>();
  for (const [i, p] of STUDENTS.entries()) {
    const isLead = p.lessons === 0;
    const email = p.email ?? `${slug(p.first)}.${slug(p.last)}@mail.test`;
    const s = await withTenant(schoolId, (tx) =>
      createStudent(tx, sys, {
        firstName: p.first,
        lastName: p.last,
        email,
        phone: `+316${String(20000000 + i * 137911).slice(0, 8)}`,
        dateOfBirth: p.dob,
        preferredTransmission: p.transmission,
        primaryInstructorId: isLead ? undefined : ctx.instructorIds[instructorFor(p, i)],
        status: isLead ? "lead" : "active",
        source: isLead ? "whatsapp" : pick(["manual", "manual", "web", "whatsapp"] as const),
        createLogin: !isLead,
      }),
    );
    studentIds.set(p.first, s.id);
    await withTenant(schoolId, async (tx) => {
      await tx.query(`UPDATE students SET locale = $2 WHERE id = $1`, [s.id, p.lang]);
      await tx.query(`UPDATE users SET locale = $2 WHERE id = (SELECT user_id FROM students WHERE id = $1)`, [s.id, p.lang]);
      // About a third of students told us when they can take lessons.
      if (!isLead && chance(0.35)) {
        const ins = HOURS[instructorFor(p, i)];
        for (const [weekday, start, end] of ins.filter(() => chance(0.6))) {
          await tx.query(`INSERT INTO student_availability (school_id, student_id, weekday, start_time, end_time) VALUES ($1,$2,$3,$4,$5)`, [schoolId, s.id, weekday, start, end]);
        }
      }
      const u = await one<{ user_id: string | null }>(tx, `SELECT user_id FROM students WHERE id = $1`, [s.id]);
      if (u?.user_id) studentActors.set(p.first, { userId: u.user_id, role: "student", schoolId, email, instructorId: null, studentId: s.id });
    });
  }
  await activateUsers(schoolId, hash);

  // Past lessons
  const skills = await withTenant(schoolId, (tx) => many<{ id: string }>(tx, `SELECT sk.id FROM skills sk JOIN level_definitions ld ON ld.id = sk.level_id ORDER BY ld.position, sk.position`));
  const levels = await withTenant(schoolId, (tx) => many<{ id: string }>(tx, `SELECT id FROM level_definitions ORDER BY position`));
  let paymentsMade = 0;
  for (const [i, p] of STUDENTS.entries()) {
    if (p.lessons === 0) continue;
    const insKey = instructorFor(p, i);
    const instructorId = ctx.instructorIds[insKey]!;
    const vehicleId = ctx.vehicleIds[INSTRUCTORS[insKey].car]!;
    const studentId = studentIds.get(p.first)!;
    const hours = HOURS[insKey];
    const perWeek = p.lessons > 14 ? 2 : 1;
    const extra = Math.round(p.lessons / 8); // a few cancellations / no-shows on top
    const total = p.lessons + extra;

    // Walk back from a recent day, one or two lessons a week.
    let cursor = now.minus({ days: int(1, 6) }).startOf("day");
    const planned: DateTime[] = [];
    let guard = 0;
    while (planned.length < total && guard++ < 400) {
      const rule = hours.find(([wd]) => wd === cursor.weekday);
      if (rule) {
        const [, s, e] = rule;
        const first = Number(s.slice(0, 2));
        const last = Number(e.slice(0, 2)) - 1;
        for (let attempt = 0; attempt < 6; attempt++) {
          const start = cursor.set({ hour: int(first, last), minute: 0 });
          const k = [key("i", instructorId, start), key("v", vehicleId, start), key("s", studentId, start.startOf("day"))];
          if (k.some((x) => busy.has(x))) continue;
          k.forEach((x) => busy.add(x));
          planned.push(start);
          cursor = cursor.minus({ days: perWeek === 2 ? int(2, 4) : int(5, 9) });
          break;
        }
      }
      cursor = cursor.minus({ days: 1 });
    }
    planned.reverse();

    const ids = await withTenant(schoolId, async (tx) => {
      const out: string[] = [];
      for (const start of planned) {
        const r = await one<{ id: string }>(
          tx,
          `INSERT INTO lessons (school_id, student_id, instructor_id, vehicle_id, start_time, end_time, status, lesson_number, price_cents, currency, booked_via, created_at)
           VALUES ($1,$2,$3,$4,$5,$6,'scheduled',1,5500,'EUR',$7,$8) RETURNING id`,
          [schoolId, studentId, instructorId, vehicleId, start.toJSDate(), start.plus({ hours: 1 }).toJSDate(), pick(["staff", "staff", "student_portal", "whatsapp_agent"]), start.minus({ days: int(3, 14) }).toJSDate()],
        );
        out.push(r!.id);
      }
      await renumberStudentLessons(tx, studentId);
      return out;
    });

    // Decide which of the planned lessons were cancelled / no-show; the rest are completed.
    let completed = 0;
    const odd = new Set<number>();
    while (odd.size < Math.min(extra, ids.length - 1)) odd.add(int(0, ids.length - 2));
    for (const [idx, lessonId] of ids.entries()) {
      const start = planned[idx]!;
      if (odd.has(idx)) {
        if (chance(0.7)) {
          const reason = pick(["Student ill", "Exam at school", "Car in maintenance", "Family matters"]);
          await withTenant(schoolId, (tx) => cancelLesson(tx, sys, lessonId, reason, { waiveFee: true }));
        } else {
          await withTenant(schoolId, (tx) => markNoShow(tx, sys, lessonId, true));
        }
        continue;
      }
      completed++;
      const b = band(completed);
      const bank = FEEDBACK[p.lang as Lang][b];
      const doneSkills = Math.min(skills.length, Math.floor(completed * 0.8));
      const res = await withTenant(schoolId, (tx) =>
        completeLesson(tx, sys, lessonId, {
          feedback: {
            strengths: pick(bank.strengths),
            weaknesses: pick(bank.weaknesses),
            practiceItems: pick(bank.practice),
            nextFocus: pick(bank.next),
            overallRating: int(3, 5),
            instructorNotes: chance(0.3) ? "Parent picks up at the school." : undefined,
          },
          skills: skills.slice(0, Math.min(skills.length, doneSkills + 2)).map((s, k) => ({ skillId: s.id, status: k < doneSkills ? "completed" : "needs_improvement" })),
          newLevelId: levels[Math.min(levels.length - 1, Math.floor(completed / 5))]!.id,
          paymentRequired: true,
        }),
      );
      // Back-date lesson completion and billing to the lesson's own date.
      await withPlatform((tx) =>
        tx.query(`UPDATE lessons SET completed_at = $2, started_at = start_time WHERE id = $1`, [lessonId, start.plus({ hours: 1 }).toJSDate()]),
      );
      if (res.paymentId) await settle(ctx, res.paymentId, start);
      paymentsMade++;
    }
  }

  // Invoices from the past: due one week after the lesson; the job marks unpaid ones overdue.
  await withPlatform((tx) =>
    tx.query(
      `UPDATE payments p SET due_date = (l.start_time AT TIME ZONE 'Europe/Amsterdam')::date + 7, created_at = l.start_time + interval '1 hour'
         FROM lessons l WHERE p.lesson_id = l.id AND p.school_id = $1`,
      [schoolId],
    ),
  );
  await withPlatform((tx) =>
    tx.query(
      `UPDATE invoices i SET due_date = p.due_date, issued_at = p.created_at FROM payments p WHERE p.invoice_id = i.id AND i.school_id = $1`,
      [schoolId],
    ),
  );
  await markOverduePayments();

  // Upcoming lessons for active students, using the real slot finder.
  for (const [i, p] of STUDENTS.entries()) {
    if (p.lessons === 0) continue;
    const studentId = studentIds.get(p.first)!;
    const instructorId = ctx.instructorIds[instructorFor(p, i)]!;
    const count = p.lessons >= 20 ? 1 : int(1, 3);
    await withTenant(schoolId, async (tx) => {
      const sc = await loadSchoolContext(tx, schoolId);
      const slots = await searchSlots(tx, sc, {
        studentId,
        from: now.plus({ hours: 14 }).toJSDate(),
        to: now.plus({ days: 21 }).toJSDate(),
        instructorIds: [instructorId],
        distinctTimes: true,
        maxSlots: 300,
      });
      let lastDay = "";
      for (let n = 0, tries = 0; n < count && tries < 40 && slots.length; tries++) {
        const s = slots[Math.floor(rand() * Math.min(slots.length, 80))]!;
        const day = DateTime.fromJSDate(s.start, { zone: ZONE }).toISODate()!;
        if (day === lastDay) continue;
        try {
          await tx.query("SAVEPOINT b");
          await bookLesson(tx, sys, { studentId, slot: s, bookedVia: pick(["staff", "student_portal", "whatsapp_agent"]) });
          await tx.query("RELEASE SAVEPOINT b");
          lastDay = day;
          n++;
        } catch {
          await tx.query("ROLLBACK TO SAVEPOINT b");
        }
      }
    });
  }

  // A realistic "today" for each instructor: morning lessons done, afternoon ones still to come.
  await seedToday(ctx, now);

  // A few students moved a lesson themselves; two requests wait for approval.
  for (const name of ["Lucas", "Chen", "Julia"]) await studentReschedule(ctx, studentActors.get(name));
  await withTenant(schoolId, (tx) => tx.query(`UPDATE school_settings SET reschedule_requires_approval = true`));
  for (const name of ["Levi", "Olga"]) await studentReschedule(ctx, studentActors.get(name));
  await withTenant(schoolId, (tx) => tx.query(`UPDATE school_settings SET reschedule_requires_approval = false`));

  // AI assessments: new leads from WhatsApp (to review), and reviewed ones for existing students.
  const answers = {
    Hamza: { has_driven_before: true, previous_lessons: "none", approx_driving_hours: 2, can_drive_manual: "unsure", traffic_comfort: 2, has_foreign_license: false, wants_transmission: "manual" },
    Noa: { has_driven_before: false, previous_lessons: "none", approx_driving_hours: null, can_drive_manual: "no", traffic_comfort: 3, has_foreign_license: false, wants_transmission: "manual" },
    Mateo: { has_driven_before: true, previous_lessons: "many", approx_driving_hours: 400, can_drive_manual: "yes", traffic_comfort: 5, has_foreign_license: true, wants_transmission: "manual" },
    Youssef: { has_driven_before: true, previous_lessons: "few", approx_driving_hours: 6, can_drive_manual: "unsure", traffic_comfort: 3, has_foreign_license: false, wants_transmission: "manual" },
    Priya: { has_driven_before: true, previous_lessons: "some", approx_driving_hours: 20, can_drive_manual: "no", traffic_comfort: 4, has_foreign_license: true, wants_transmission: "automatic" },
  } as const;
  for (const [name, a] of Object.entries(answers)) {
    const studentId = studentIds.get(name)!;
    const res = await withTenant(schoolId, (tx) => createAssessment(tx, sys, { studentId, answers: { ...a }, source: "whatsapp_agent" }));
    if (name === "Youssef") await withTenant(schoolId, (tx) => reviewAssessment(tx, owner, res.id, res.level!.id));
    if (name === "Priya") await withTenant(schoolId, (tx) => reviewAssessment(tx, owner, res.id, levels[1]!.id, "Needs to get used to Dutch traffic first"));
  }
  // Reviewed assessments reset the level; restore current levels for students with history.
  for (const name of ["Youssef", "Priya"]) {
    const p = STUDENTS.find((s) => s.first === name)!;
    const lvl = levels[Math.min(levels.length - 1, Math.floor(p.lessons / 5))]!;
    await withTenant(schoolId, (tx) => tx.query(`UPDATE students SET current_level_id = $2, level_confirmed = true WHERE id = $1`, [studentIds.get(name), lvl.id]));
  }

  // WhatsApp conversations
  await withTenant(schoolId, async (tx) => {
    await tx.query(
      `INSERT INTO whatsapp_accounts (school_id, phone_number_id, waba_id, display_phone_number, access_token_encrypted) VALUES ($1,'demo-phone-number-id','demo-waba','+31 20 123 4567',$2)`,
      [schoolId, encryptSecret("demo-token-not-real")],
    );
    for (const [ci, chat] of CHATS.entries()) {
      const studentId = studentIds.get(chat.student)!;
      const st = await one<{ phone_e164: string; first_name: string; last_name: string }>(tx, `SELECT phone_e164, first_name, last_name FROM students WHERE id = $1`, [studentId]);
      const startedAt = now.minus({ days: 6 - ci, hours: int(1, 8) });
      const conv = (await one<{ id: string }>(
        tx,
        `INSERT INTO whatsapp_conversations (school_id, wa_phone_e164, wa_profile_name, student_id, status, handoff_reason, last_inbound_at, last_message_at, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$7,$8) RETURNING id`,
        [schoolId, st!.phone_e164, `${st!.first_name} ${st!.last_name}`, studentId, chat.status, chat.handoffReason ?? null, startedAt.plus({ minutes: chat.messages.length * 3 }).toJSDate(), startedAt.toJSDate()],
      ))!;
      for (const [mi, m] of chat.messages.entries()) {
        const at = startedAt.plus({ minutes: mi * 3 }).toJSDate();
        const reply = m.from === "contact" ? chat.messages[mi + 1] : undefined;
        await tx.query(
          `INSERT INTO whatsapp_messages (school_id, conversation_id, direction, sender, sender_user_id, wa_message_id, body, intent, ai_response, processing_status, delivery_status, metadata, created_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'done',$10,$11,$12)`,
          [
            schoolId,
            conv.id,
            m.from === "contact" ? "inbound" : "outbound",
            m.from,
            m.from === "staff" ? ownerRow.id : null,
            `wamid.seed.${ci}.${mi}`,
            m.text,
            m.intent ?? null,
            reply && reply.from === "ai_agent" ? reply.text : null,
            m.from === "contact" ? null : "read",
            JSON.stringify(m.tools ? { tool_calls: m.tools.map((name) => ({ name })) } : {}),
            at,
          ],
        );
      }
    }
  });

  // ---------------------------------------------------------------- school B
  await seedSecondSchool(hash, now);

  // Nothing from the seed is e-mailed.
  await withPlatform((tx) => tx.query(`UPDATE notifications SET status = 'cancelled', last_error = 'seed data – not sent' WHERE status = 'queued'`));

  const stats = await withPlatform((tx) =>
    one<{ lessons: number; completed: number; upcoming: number; payments: number; paid: number; overdue: number; feedback: number }>(
      tx,
      `SELECT (SELECT count(*)::int FROM lessons) AS lessons,
              (SELECT count(*)::int FROM lessons WHERE status = 'completed') AS completed,
              (SELECT count(*)::int FROM lessons WHERE status IN ('scheduled','confirmed') AND start_time > now()) AS upcoming,
              (SELECT count(*)::int FROM payments) AS payments,
              (SELECT count(*)::int FROM payments WHERE status = 'paid') AS paid,
              (SELECT count(*)::int FROM payments WHERE status = 'overdue') AS overdue,
              (SELECT count(*)::int FROM lesson_feedback) AS feedback`,
    ),
  );
  console.log(`
Synthetic data ready (${paymentsMade} lessons billed). ${JSON.stringify(stats)}
Password for every account: ${PASSWORD}

  Platform admin      admin@platform.test
  School portal       owner@abc.test                      (/login)
  Instructor app      john@abc.test (English) · fatima@abc.test (Arabic) · sanne@abc.test (Dutch)   (/login/instructor)
  Student app         priya@abc.test (English) · anna@abc.test (Dutch) · youssef@abc.test (Arabic) · bram@abc.test   (/login/student)
  Second school       kees@noord.test (owner who also teaches)
`);
}

async function seedToday(ctx: Ctx, now: DateTime) {
  // Hours relative to the current time, so there are always lessons behind and ahead (kept within 07:00–22:00).
  const offsets: Record<string, number[]> = { john: [-5, -3, 1, 3], fatima: [-4, -2, 2], sanne: [-6, -1, 2] };
  for (const [insKey, offs] of Object.entries(offsets)) {
    const hours = [...new Set(offs.map((o) => Math.min(21, Math.max(7, now.hour + o))))];
    const instructorId = ctx.instructorIds[insKey]!;
    const vehicleId = ctx.vehicleIds[INSTRUCTORS[insKey as InstructorKey].car]!;
    const roster = await withTenant(ctx.schoolId, (tx) =>
      many<{ id: string; locale: Lang }>(tx, `SELECT id, locale FROM students WHERE primary_instructor_id = $1 AND status = 'active' ORDER BY student_number`, [instructorId]),
    );
    for (const [n, hour] of hours.entries()) {
      const student = roster[(n * 3 + 1) % roster.length];
      if (!student) continue;
      const start = now.startOf("day").set({ hour });
      const slot = { start: start.toJSDate(), end: start.plus({ hours: 1 }).toJSDate(), instructorId, vehicleId };
      try {
        const lesson = await withTenant(ctx.schoolId, (tx) => bookLesson(tx, ctx.sys, { studentId: student.id, slot, bookedVia: "staff", overrideAvailability: true }));
        if (start.plus({ hours: 1 }) < now) {
          const bank = FEEDBACK[student.locale].mid;
          const res = await withTenant(ctx.schoolId, (tx) =>
            completeLesson(tx, ctx.sys, lesson.id, { feedback: { strengths: pick(bank.strengths), weaknesses: pick(bank.weaknesses), practiceItems: pick(bank.practice), nextFocus: pick(bank.next), overallRating: 4 }, paymentRequired: true }),
          );
          if (res.paymentId && chance(0.5)) await settle(ctx, res.paymentId, start);
        } else if (n % 2 === 0) {
          await withTenant(ctx.schoolId, (tx) => tx.query(`UPDATE lessons SET status = 'confirmed' WHERE id = $1`, [lesson.id]));
        }
      } catch {
        // Slot clashes with the student's other lessons: skip it.
      }
    }
  }
}

/** Pay a payment the way it would really happen: mostly Stripe (webhook), some cash; recent ones may still be open. */
async function settle(ctx: Ctx, paymentId: string, lessonStart: DateTime) {
  const ageDays = DateTime.now().diff(lessonStart, "days").days;
  const pPaid = ageDays > 14 ? 0.92 : ageDays > 3 ? 0.7 : 0.3;
  if (!chance(pPaid)) return;
  const paidAt = lessonStart.plus({ hours: int(2, 24 * Math.min(6, Math.max(1, Math.floor(ageDays)))) });
  if (chance(0.8)) {
    const pay = await withTenant(ctx.schoolId, (tx) => one<{ amount_cents: number; currency: string }>(tx, `SELECT amount_cents, currency FROM payments WHERE id = $1`, [paymentId]));
    await withTenant(ctx.schoolId, (tx) =>
      applyProviderEvent(tx, ctx.schoolId, {
        provider: "stripe",
        eventId: `evt_seed_${paymentId}`,
        eventType: "checkout.session.completed",
        kind: "succeeded",
        paymentId,
        amountCents: pay!.amount_cents,
        currency: pay!.currency,
        providerCheckoutId: `cs_seed_${paymentId.slice(0, 8)}`,
        providerPaymentId: `pi_seed_${paymentId.slice(0, 8)}`,
        raw: { seed: true },
      }),
    );
  } else {
    await withTenant(ctx.schoolId, (tx) => recordManualPayment(tx, ctx.owner, paymentId, "cash"));
  }
  await withPlatform((tx) => tx.query(`UPDATE payments SET paid_at = LEAST($2::timestamptz, now()) WHERE id = $1`, [paymentId, paidAt.toJSDate()]));
}

async function studentReschedule(ctx: Ctx, actor: SchoolActor | undefined) {
  if (!actor) return;
  await withTenant(ctx.schoolId, async (tx) => {
    const lesson = await one<{ id: string; start_time: Date; end_time: Date }>(
      tx,
      `SELECT id, start_time, end_time FROM lessons WHERE student_id = $1 AND status = 'scheduled' AND start_time > now() + interval '30 hours' ORDER BY start_time LIMIT 1`,
      [actor.studentId],
    );
    if (!lesson) return;
    const sc = await loadSchoolContext(tx, ctx.schoolId);
    const slots = await searchSlots(tx, sc, { studentId: actor.studentId!, from: new Date(lesson.start_time.getTime() + 86400000), to: new Date(lesson.start_time.getTime() + 6 * 86400000), ignoreLessonIds: [lesson.id], distinctTimes: true, maxSlots: 20 });
    const slot = slots[Math.floor(rand() * slots.length)];
    if (!slot) return;
    await rescheduleLesson(tx, { type: "user", schoolId: ctx.schoolId, actor }, lesson.id, slot, { channel: "student_portal", reason: pick(["Work shift changed", "Dentist appointment", "School exam"]) });
  });
}

async function seedSecondSchool(hash: string, now: DateTime) {
  const school = await createSchool(
    { name: "Rijschool Noord", slug: "noord", timezone: ZONE, currency: "EUR", ownerEmail: "kees@noord.test", ownerName: "Kees", phone: "+31 10 765 4321", address: "Noordsingel 12, Rotterdam", planCode: "starter" },
    null,
  );
  const schoolId = school.id;
  const sys: Principal = { type: "system", schoolId };
  await activateUsers(schoolId, hash);
  const ownerRow = (await withTenant(schoolId, (tx) => one<{ id: string }>(tx, `SELECT id FROM users WHERE role = 'school_owner'`)))!;
  const owner: SchoolActor = { userId: ownerRow.id, role: "school_owner", schoolId, email: "kees@noord.test", instructorId: null, studentId: null };
  await withTenant(schoolId, async (tx) => {
    await tx.query(`UPDATE users SET locale = 'nl'`);
    const car = await createVehicle(tx, sys, { registrationNumber: "NR-001-D", brand: "Kia", model: "Picanto", transmission: "manual" });
    await makeOwnerAnInstructor(tx, { type: "user", schoolId, actor: owner });
    const ins = (await one<{ id: string }>(tx, `SELECT id FROM instructors WHERE user_id = $1`, [ownerRow.id]))!;
    await tx.query(`UPDATE instructors SET first_name = 'Kees', last_name = 'Jansen', default_vehicle_id = $2 WHERE id = $1`, [ins.id, car.id]);
    for (const wd of [1, 2, 3, 4, 5]) await addAvailabilityRule(tx, sys, { instructorId: ins.id, isRecurring: true, weekday: wd, start: "09:00", end: "17:00" });
    for (const [n, name] of ["Ruben Koster", "Fleur de Wit", "Mohamed Amrani", "Eva Brouwer", "Jesse Lammers"].entries()) {
      const [first, ...rest] = name.split(" ");
      const s = await createStudent(tx, sys, { firstName: first!, lastName: rest.join(" "), email: `${slug(first!)}@noord.test`, phone: `+3162900000${n}`, primaryInstructorId: ins.id, createLogin: false });
      for (let k = 0; k < 2 + n; k++) {
        const start = now.minus({ days: 3 + k * 7 + n }).set({ hour: 9 + n, minute: 0, second: 0, millisecond: 0 });
        if (start.weekday > 5) continue;
        await tx.query(
          `INSERT INTO lessons (school_id, student_id, instructor_id, vehicle_id, start_time, end_time, status, lesson_number, price_cents, currency, completed_at)
           VALUES ($1,$2,$3,$4,$5,$6,'completed',1,5000,'EUR',$6)`,
          [schoolId, s.id, ins.id, car.id, start.toJSDate(), start.plus({ hours: 1 }).toJSDate()],
        );
      }
      await renumberStudentLessons(tx, s.id);
    }
  });
  await activateUsers(schoolId, hash);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(closePools);
