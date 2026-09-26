/**
 * Numbers behind the owner dashboard charts. All weeks and hours are in the
 * school's time zone; every query runs inside withTenant (RLS scoped).
 */
import { DateTime } from "luxon";
import { many, one, sequential, type Tx } from "@/lib/db";

export type WeekPoint = { week: string; value: number };

export async function schoolInsights(tx: Tx, zone: string) {
  const now = DateTime.now().setZone(zone);
  const weekStart = now.startOf("week");
  const days7 = now.startOf("day");

  const weekly = (valueSql: string, from: string, join: string) =>
    many<WeekPoint>(
      tx,
      `WITH weeks AS (
         SELECT generate_series(date_trunc('week', now() AT TIME ZONE $1) - interval '11 weeks', date_trunc('week', now() AT TIME ZONE $1), interval '1 week') AS wk)
       SELECT to_char(wk, 'YYYY-MM-DD') AS week, ${valueSql} AS value
         FROM weeks LEFT JOIN ${from} ON ${join}
        GROUP BY wk ORDER BY wk`,
      [zone],
    );
  const inWeek = (col: string) => `(${col} AT TIME ZONE $1) >= wk AND (${col} AT TIME ZONE $1) < wk + interval '1 week'`;

  const [revenue, lessons, newStudents, totals, heat, payMix, load, levels] = await sequential([
    () => weekly("COALESCE(sum(p.amount_cents), 0)::int", "payments p", `p.status = 'paid' AND ${inWeek("p.paid_at")}`),
    () => weekly("count(l.id)::int", "lessons l", `l.status = 'completed' AND ${inWeek("l.start_time")}`),
    () => weekly("count(s.id)::int", "students s", inWeek("s.created_at")),
    () =>
      one<{ revenue_30d: number; revenue_prev: number; lessons_30d: number; lessons_prev: number; active: number; leads: number; outstanding: number; overdue: number }>(
        tx,
        `SELECT
           (SELECT COALESCE(sum(amount_cents),0)::int FROM payments WHERE status = 'paid' AND paid_at > now() - interval '30 days') AS revenue_30d,
           (SELECT COALESCE(sum(amount_cents),0)::int FROM payments WHERE status = 'paid' AND paid_at > now() - interval '60 days' AND paid_at <= now() - interval '30 days') AS revenue_prev,
           (SELECT count(*)::int FROM lessons WHERE status = 'completed' AND start_time > now() - interval '30 days') AS lessons_30d,
           (SELECT count(*)::int FROM lessons WHERE status = 'completed' AND start_time > now() - interval '60 days' AND start_time <= now() - interval '30 days') AS lessons_prev,
           (SELECT count(*)::int FROM students WHERE status = 'active') AS active,
           (SELECT count(*)::int FROM students WHERE status = 'lead') AS leads,
           (SELECT COALESCE(sum(amount_cents),0)::int FROM payments WHERE status IN ('pending','overdue','failed')) AS outstanding,
           (SELECT count(*)::int FROM payments WHERE status = 'overdue') AS overdue`,
      ),
    // Lessons by weekday x start hour: the last 8 weeks plus what is booked for the next 2.
    () =>
      many<{ dow: number; hour: number; n: number }>(
        tx,
        `SELECT extract(isodow FROM start_time AT TIME ZONE $1)::int AS dow, extract(hour FROM start_time AT TIME ZONE $1)::int AS hour, count(*)::int AS n
           FROM lessons
          WHERE status NOT IN ('cancelled','rescheduled') AND start_time > now() - interval '8 weeks' AND start_time < now() + interval '2 weeks'
          GROUP BY 1, 2`,
        [zone],
      ),
    // Money by payment state, last 90 days.
    () =>
      many<{ state: "paid" | "pending" | "overdue"; cents: number; n: number }>(
        tx,
        `SELECT CASE WHEN status = 'paid' THEN 'paid' WHEN status = 'pending' THEN 'pending' ELSE 'overdue' END AS state,
                sum(amount_cents)::int AS cents, count(*)::int AS n
           FROM payments WHERE status IN ('paid','pending','overdue','failed') AND created_at > now() - interval '90 days'
          GROUP BY 1`,
      ),
    // Booked vs available hours per instructor for the next 7 days.
    () =>
      many<{ id: string; name: string; available_min: number; booked_min: number }>(
        tx,
        `WITH days AS (SELECT ($1::date + g)::date AS d FROM generate_series(0, 6) g)
         SELECT i.id, i.first_name || ' ' || i.last_name AS name,
                COALESCE((SELECT sum(extract(epoch FROM a.end_time - a.start_time) / 60)
                            FROM instructor_availability a JOIN days ON
                                 (a.is_recurring AND a.weekday = extract(isodow FROM days.d)
                                   AND (a.valid_from IS NULL OR a.valid_from <= days.d) AND (a.valid_until IS NULL OR a.valid_until >= days.d))
                              OR (NOT a.is_recurring AND a.specific_date = days.d)
                           WHERE a.instructor_id = i.id), 0)::int AS available_min,
                COALESCE((SELECT sum(extract(epoch FROM l.end_time - l.start_time) / 60) FROM lessons l
                           WHERE l.instructor_id = i.id AND l.status IN ('scheduled','confirmed','in_progress','completed')
                             AND l.start_time >= $2 AND l.start_time < $3), 0)::int AS booked_min
           FROM instructors i WHERE i.status = 'active' ORDER BY i.first_name`,
        [days7.toISODate(), days7.toJSDate(), days7.plus({ days: 7 }).toJSDate()],
      ),
    () =>
      many<{ position: number | null; name: string; n: number }>(
        tx,
        `SELECT ld.position, ld.name, count(s.id)::int AS n
           FROM level_definitions ld LEFT JOIN students s ON s.current_level_id = ld.id AND s.status = 'active'
          GROUP BY ld.id ORDER BY ld.position`,
      ),
  ]);
  const unassessed = (await one<{ n: number }>(tx, `SELECT count(*)::int AS n FROM students WHERE status = 'active' AND current_level_id IS NULL`))!.n;

  return {
    weekStart: weekStart.toISODate()!,
    revenue,
    lessons,
    newStudents,
    totals: totals!,
    heat,
    payMix,
    load,
    levels: unassessed ? [...levels, { position: null, name: "Not assessed yet", n: unassessed }] : levels,
  };
}
