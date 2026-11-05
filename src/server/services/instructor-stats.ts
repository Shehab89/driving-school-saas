/**
 * The school's view of one instructor: weekly working hours, how much of this
 * week is booked, ratings from students, and pay for hours taught.
 */
import { DateTime } from "luxon";
import { many, one, type Tx } from "@/lib/db";
import { ForbiddenError, NotFoundError, ValidationError } from "@/lib/errors";
import { can } from "@/lib/rbac";
import type { Principal } from "../principal";
import { audit } from "./audit";
import { instructorRatings, recentReviews } from "./reviews";

const LIVE = `('scheduled','confirmed','in_progress','completed')`;
const hoursBetween = (a: string, b: string) => {
  const [ah, am] = a.split(":").map(Number);
  const [bh, bm] = b.split(":").map(Number);
  return (bh! * 60 + bm! - (ah! * 60 + am!)) / 60;
};

export async function instructorOverview(tx: Tx, p: Principal, instructorId: string, timezone: string) {
  if (p.type !== "user" || !can(p.actor.role, "students:read_all")) throw new ForbiddenError();
  const i = await one<{ id: string; name: string; email: string | null; phone: string | null; status: string; hourly_rate_cents: number | null; vehicle: string | null; currency: string }>(
    tx,
    `SELECT i.id, i.first_name || ' ' || i.last_name AS name, i.email, i.phone, i.status, i.hourly_rate_cents,
            CASE WHEN v.id IS NULL THEN NULL ELSE v.brand || ' ' || v.model || ' (' || v.registration_number || ')' END AS vehicle, s.currency
       FROM instructors i JOIN schools s ON s.id = i.school_id LEFT JOIN vehicles v ON v.id = i.default_vehicle_id WHERE i.id = $1`,
    [instructorId],
  );
  if (!i) throw new NotFoundError("Instructor");
  const now = DateTime.now().setZone(timezone);
  const weekStart = now.startOf("week"), weekEnd = weekStart.plus({ weeks: 1 });
  const monthStart = now.startOf("month");
  const today = now.toISODate();

  const rules = await many<{ weekday: number; start_time: string; end_time: string }>(
    tx,
    `SELECT weekday, start_time::text, end_time::text FROM instructor_availability
      WHERE instructor_id = $1 AND is_recurring AND (valid_from IS NULL OR valid_from <= $2::date) AND (valid_until IS NULL OR valid_until >= $2::date)
      ORDER BY weekday, start_time`,
    [instructorId, today],
  );
  const week = await many<{ start_time: Date; end_time: Date }>(
    tx,
    `SELECT start_time, end_time FROM lessons WHERE instructor_id = $1 AND status IN ${LIVE} AND start_time >= $2 AND start_time < $3`,
    [instructorId, weekStart.toJSDate(), weekEnd.toJSDate()],
  );
  const taught = await one<{ minutes: number; lessons: number }>(
    tx,
    `SELECT COALESCE(sum(extract(epoch FROM end_time - start_time) / 60), 0)::int AS minutes, count(*)::int AS lessons
       FROM lessons WHERE instructor_id = $1 AND status = 'completed' AND start_time >= $2 AND start_time < $3`,
    [instructorId, monthStart.toJSDate(), now.toJSDate()],
  );
  const days = [1, 2, 3, 4, 5, 6, 7].map((wd) => {
    const slots = rules.filter((r) => r.weekday === wd);
    const available = slots.reduce((a, r) => a + hoursBetween(r.start_time, r.end_time), 0);
    const booked = week
      .filter((l) => DateTime.fromJSDate(l.start_time).setZone(timezone).weekday === wd)
      .reduce((a, l) => a + (l.end_time.getTime() - l.start_time.getTime()) / 3_600_000, 0);
    return { weekday: wd, date: weekStart.plus({ days: wd - 1 }).toJSDate(), slots: slots.map((s) => [s.start_time.slice(0, 5), s.end_time.slice(0, 5)] as const), available, booked };
  });
  const available = days.reduce((a, d) => a + d.available, 0);
  const booked = days.reduce((a, d) => a + d.booked, 0);
  const rating = (await instructorRatings(tx, p)).get(instructorId) ?? { avg: 0, count: 0 };
  const hoursTaught = (taught?.minutes ?? 0) / 60;
  return {
    instructor: i,
    days,
    week: { available, booked, free: Math.max(0, available - booked) },
    month: { hours: hoursTaught, lessons: taught?.lessons ?? 0, payCents: i.hourly_rate_cents == null ? null : Math.round(hoursTaught * i.hourly_rate_cents) },
    rating,
    reviews: await recentReviews(tx, p, instructorId, 20),
  };
}

/** The owner sets what the school pays the instructor per hour taught. */
export async function setHourlyRate(tx: Tx, p: Principal, instructorId: string, cents: number | null) {
  if (p.type !== "user" || !can(p.actor.role, "pricing:write")) throw new ForbiddenError();
  if (cents !== null && (!Number.isInteger(cents) || cents < 0 || cents > 100000)) throw new ValidationError("Enter an hourly rate between 0 and 1000.");
  const r = await tx.query(`UPDATE instructors SET hourly_rate_cents = $2 WHERE id = $1`, [instructorId, cents]);
  if (!r.rowCount) throw new NotFoundError("Instructor");
  await audit(tx, p, "instructor.hourly_rate", "instructor", instructorId, { hourly_rate_cents: cents });
}
