/**
 * Demo data: a SaaS admin and "ABC Driving School" with an owner, an
 * instructor, a car, two students, past lessons with feedback/payments and
 * upcoming lessons. All demo users share the password printed at the end.
 *
 *   npm run db:seed
 */
import { DateTime } from "luxon";
import { closePools, one, withPlatform, withTenant } from "../src/lib/db";
import { hashPassword } from "../src/lib/crypto";
import type { Principal } from "../src/server/principal";
import { createSchool } from "../src/server/services/schools";
import { addAvailabilityRule, createInstructor, createVehicle } from "../src/server/services/staff";
import { createStudent } from "../src/server/services/students";
import { bookLesson, completeLesson } from "../src/server/services/lessons";
import { applyProgressUpdate } from "../src/server/services/progress";

const PASSWORD = process.env.SEED_PASSWORD ?? "demo-password-123";

async function main() {
  const hash = await hashPassword(PASSWORD);
  const existing = await withPlatform((tx) => one(tx, `SELECT 1 FROM schools WHERE slug = 'abc-driving'`));
  if (existing) {
    console.log("Demo data already present.");
    return;
  }
  await withPlatform((tx) =>
    tx.query(
      `INSERT INTO users (school_id, role, email, password_hash, status) VALUES (NULL, 'saas_admin', 'admin@platform.test', $1, 'active')
       ON CONFLICT DO NOTHING`,
      [hash],
    ),
  );

  const school = await createSchool(
    { name: "ABC Driving School", slug: "abc-driving", timezone: "Europe/Amsterdam", currency: "EUR", ownerEmail: "owner@abc.test", ownerName: "Olivia", email: "hello@abc.test", phone: "+31 20 123 4567", address: "Damrak 1, Amsterdam" },
    null,
  );
  const schoolId = school.id;
  const sys: Principal = { type: "system", schoolId };

  const ids = await withTenant(schoolId, async (tx) => {
    await tx.query(
      `UPDATE school_settings SET school_info_for_agent = $1`,
      ["Packages: 10 lessons for €520. Exam (CBR) fee €150, exam lesson €110. Pick-up from home or Amsterdam Centraal. Theory course not offered."],
    );
    const car = await createVehicle(tx, sys, { registrationNumber: "AB-123-C", brand: "Toyota", model: "Yaris", transmission: "manual" });
    await createVehicle(tx, sys, { registrationNumber: "XY-987-Z", brand: "Volkswagen", model: "Polo", transmission: "automatic" });
    const john = await createInstructor(tx, sys, { firstName: "John", lastName: "de Vries", email: "john@abc.test", phone: "+31611111111", defaultVehicleId: car.id, color: "#1f6feb" });
    for (let d = 1; d <= 6; d++) {
      await addAvailabilityRule(tx, sys, { instructorId: john.id, isRecurring: true, weekday: d, start: d === 6 ? "09:00" : "08:00", end: d === 6 ? "14:00" : "18:00" });
    }
    const anna = await createStudent(tx, sys, { firstName: "Anna", lastName: "Jansen", email: "anna@abc.test", phone: "+31622222222", primaryInstructorId: john.id });
    const bram = await createStudent(tx, sys, { firstName: "Bram", lastName: "Bakker", email: "bram@abc.test", phone: "+31633333333", preferredTransmission: "manual" });
    await tx.query(`UPDATE users SET password_hash = $1, status = 'active'`, [hash]);
    await tx.query(`UPDATE school_settings SET min_booking_lead_hours = 0`);
    return { john: john.id, anna: anna.id, bram: bram.id, car: car.id };
  });

  // Past lessons for Anna: book in the future, then move into the past (seed only) and complete.
  const zone = "Europe/Amsterdam";
  for (let i = 0; i < 4; i++) {
    const start = DateTime.now().setZone(zone).plus({ days: 30 + i }).set({ hour: 10, minute: 0, second: 0, millisecond: 0 });
    const lesson = await withTenant(schoolId, (tx) =>
      bookLesson(tx, sys, { studentId: ids.anna, slot: { start: start.toJSDate(), end: start.plus({ hours: 1 }).toJSDate(), instructorId: ids.john, vehicleId: ids.car }, bookedVia: "staff", overrideAvailability: true }),
    );
    const past = DateTime.now().setZone(zone).minus({ days: 3 * (4 - i) }).set({ hour: 10, minute: 0, second: 0, millisecond: 0 });
    await withPlatform((tx) => tx.query(`UPDATE lessons SET start_time = $2, end_time = $3 WHERE id = $1`, [lesson.id, past.toJSDate(), past.plus({ hours: 1 }).toJSDate()]));
    await withTenant(schoolId, async (tx) => {
      const skills = (await tx.query<{ id: string; name: string; position: number }>(`SELECT sk.id, sk.name, ld.position FROM skills sk JOIN level_definitions ld ON ld.id = sk.level_id ORDER BY ld.position, sk.position`)).rows;
      const levels = (await tx.query<{ id: string }>(`SELECT id FROM level_definitions ORDER BY position`)).rows;
      await completeLesson(tx, sys, lesson.id, {
        feedback: {
          strengths: ["Good cockpit drill and smooth moving off", "Confident steering on quiet roads", "Good mirror checks", "Handled roundabouts calmly"][i],
          weaknesses: ["Clutch control on hills", "Late signalling", "Speed on approach to junctions", "Lane choice on multi-lane roundabouts"][i],
          practiceItems: ["Hill starts", "Mirror–signal–manoeuvre routine", "Junction approach", "Roundabout lane discipline"][i],
          nextFocus: ["Junctions", "Junctions & observation", "Roundabouts", "Urban driving in traffic"][i],
          overallRating: 3 + (i % 2),
        },
        skills: skills.slice(0, 4 + i * 2).map((s, idx) => ({ skillId: s.id, status: idx < 2 + i * 2 ? "completed" : "needs_improvement" })),
        newLevelId: levels[Math.min(2, Math.floor(i / 2) + 1)]!.id,
      });
    });
  }
  // Mark the first payments as paid (cash), leave the last pending.
  await withTenant(schoolId, async (tx) => {
    await tx.query(
      `UPDATE payments SET status = 'paid', paid_at = now(), provider = 'manual'
        WHERE id IN (SELECT id FROM payments ORDER BY created_at LIMIT 3)`,
    );
    await tx.query(`UPDATE lessons SET payment_status = 'paid' WHERE id IN (SELECT lesson_id FROM payments WHERE status = 'paid')`);
    await tx.query(`UPDATE invoices SET status = 'paid', paid_at = now() WHERE id IN (SELECT invoice_id FROM payments WHERE status = 'paid')`);
  });

  // Upcoming lessons.
  const upcoming = [
    { student: ids.anna, days: 2, hour: 14 },
    { student: ids.anna, days: 9, hour: 14 },
    { student: ids.bram, days: 1, hour: 9 },
    { student: ids.bram, days: 4, hour: 11 },
  ];
  for (const u of upcoming) {
    const start = DateTime.now().setZone(zone).plus({ days: u.days }).set({ hour: u.hour, minute: 0, second: 0, millisecond: 0 });
    // Skip Sundays (no availability).
    const s = start.weekday === 7 ? start.plus({ days: 1 }) : start;
    await withTenant(schoolId, (tx) =>
      bookLesson(tx, sys, { studentId: u.student, slot: { start: s.toJSDate(), end: s.plus({ hours: 1 }).toJSDate(), instructorId: ids.john, vehicleId: ids.car }, bookedVia: "staff", overrideAvailability: true }),
    );
  }
  await withTenant(schoolId, (tx) => applyProgressUpdate(tx, sys, { studentId: ids.bram, lessonId: null, skills: [], newLevelId: null }));
  // Restore the normal booking lead time (disabled above to place seed lessons freely).
  await withTenant(schoolId, (tx) => tx.query(`UPDATE school_settings SET min_booking_lead_hours = 12`));
  // Seed e-mails are not sent.
  await withPlatform((tx) => tx.query(`UPDATE notifications SET status = 'cancelled' WHERE school_id = $1`, [schoolId]));

  console.log(`
Demo ready. Password for every account: ${PASSWORD}
  SaaS admin : admin@platform.test
  Owner      : owner@abc.test
  Instructor : john@abc.test
  Students   : anna@abc.test, bram@abc.test
`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(closePools);
