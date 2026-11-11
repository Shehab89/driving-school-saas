/**
 * "Tell me when an earlier time opens" (a waiting list without the admin).
 *
 * Students switch it on in the app. When a lesson is cancelled or moved away,
 * the freed time is offered to a few of them by e-mail/WhatsApp with a link to
 * the booking screen. Whoever books first gets it: booking goes through the
 * normal engine, so nobody can double-book and the school's rules still apply.
 *
 * Who is asked (at most MAX_PER_SLOT students):
 *  - the school lets students book online;
 *  - the freed time starts at least MIN_LEAD_HOURS from now and within WINDOW_DAYS;
 *  - active students who switched the alert on, other than the one who freed it;
 *  - who drive with that instructor (or have no fixed instructor) and the same gearbox;
 *  - whose next lesson is later than the freed time (or who have none);
 *  - who were not sent such a message in the last QUIET_HOURS.
 * Students of the same instructor go first, then those waiting longest for a lesson.
 */
import { many, type Tx } from "@/lib/db";
import { ForbiddenError } from "@/lib/errors";
import type { Principal } from "../principal";
import { audit } from "./audit";
import { enqueueNotification } from "./notifications";
import { env } from "@/lib/env";

export const SLOT_ALERT = { MAX_PER_SLOT: 5, MIN_LEAD_HOURS: 3, WINDOW_DAYS: 21, QUIET_HOURS: 6 } as const;

interface FreedLesson {
  id: string;
  school_id: string;
  student_id: string;
  instructor_id: string;
  vehicle_id: string | null;
  start_time: Date;
  end_time: Date;
}

/** Offer a freed lesson time to students waiting for an earlier lesson. Returns how many were told. */
export async function offerFreedSlot(tx: Tx, lesson: FreedLesson): Promise<number> {
  const rows = await many<{ id: string; email: string | null; first_name: string; instructor_name: string; vehicle: string | null }>(
    tx,
    `WITH freed AS (
       SELECT $2::uuid AS instructor_id, $3::timestamptz AS start_time,
              (SELECT transmission FROM vehicles WHERE id = $4) AS transmission
     )
     SELECT s.id, s.email, s.first_name,
            (SELECT first_name || ' ' || last_name FROM instructors WHERE id = $2) AS instructor_name,
            (SELECT brand || ' ' || model FROM vehicles WHERE id = $4) AS vehicle
       FROM students s, freed f, school_settings ss
      WHERE ss.school_id = s.school_id AND ss.student_self_booking
        AND s.earlier_slot_alert AND s.status = 'active' AND s.id <> $1
        AND s.email IS NOT NULL
        AND f.start_time >= now() + make_interval(hours => ${SLOT_ALERT.MIN_LEAD_HOURS})
        AND f.start_time <= now() + make_interval(days => ${SLOT_ALERT.WINDOW_DAYS})
        AND (s.primary_instructor_id IS NULL OR s.primary_instructor_id = f.instructor_id)
        AND (f.transmission IS NULL OR f.transmission = s.preferred_transmission)
        AND (s.earlier_slot_alert_at IS NULL OR s.earlier_slot_alert_at < now() - make_interval(hours => ${SLOT_ALERT.QUIET_HOURS}))
        AND NOT EXISTS (SELECT 1 FROM lessons l WHERE l.student_id = s.id AND l.status IN ('scheduled','confirmed','in_progress')
                         AND l.start_time <= f.start_time AND l.end_time > now())
      ORDER BY (s.primary_instructor_id = f.instructor_id) DESC NULLS LAST,
               (SELECT max(start_time) FROM lessons l WHERE l.student_id = s.id AND l.status = 'completed') ASC NULLS FIRST,
               s.created_at
      LIMIT ${SLOT_ALERT.MAX_PER_SLOT}`,
    [lesson.student_id, lesson.instructor_id, lesson.start_time, lesson.vehicle_id],
  );
  for (const s of rows) {
    await enqueueNotification(tx, {
      schoolId: lesson.school_id,
      type: "slot_opened",
      to: s.email,
      studentId: s.id,
      lessonId: lesson.id,
      payload: {
        lesson: {
          lesson_number: 0,
          start_time: lesson.start_time,
          end_time: lesson.end_time,
          student_first_name: s.first_name,
          instructor_name: s.instructor_name,
          vehicle: s.vehicle,
        },
        book_url: `${env.appUrl}/student/book`,
      },
      dedupeKey: `slot_opened:${lesson.id}:${s.id}`,
    });
  }
  if (rows.length) {
    await tx.query(`UPDATE students SET earlier_slot_alert_at = now() WHERE id = ANY($1::uuid[])`, [rows.map((r) => r.id)]);
  }
  return rows.length;
}

/** The student switches the alert on or off (own account only). */
export async function setEarlierSlotAlert(tx: Tx, p: Principal, studentId: string, on: boolean) {
  if (p.type !== "user" || p.actor.role !== "student" || p.actor.studentId !== studentId) throw new ForbiddenError();
  await tx.query(`UPDATE students SET earlier_slot_alert = $2 WHERE id = $1`, [studentId, on]);
  await audit(tx, p, on ? "student.slot_alert_on" : "student.slot_alert_off", "student", studentId);
}
