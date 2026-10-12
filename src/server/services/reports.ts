/**
 * School reports. All money figures come from payments the system has
 * confirmed (a signed provider webhook or staff recording cash/bank), never
 * from what was merely invoiced, so "revenue" here matches the bank.
 * Date ranges are whole days in the school's timezone, [from, to] inclusive.
 */
import { DateTime } from "luxon";
import { many, one, type Tx } from "@/lib/db";
import { ValidationError } from "@/lib/errors";

export interface Range {
  from: string; // yyyy-mm-dd
  to: string; // yyyy-mm-dd, inclusive
  timezone: string;
}

export function parseRange(from: string | undefined, to: string | undefined, timezone: string): Range {
  const today = DateTime.now().setZone(timezone);
  const f = from ? DateTime.fromISO(from, { zone: timezone }) : today.startOf("month");
  const t = to ? DateTime.fromISO(to, { zone: timezone }) : today;
  if (!f.isValid || !t.isValid) throw new ValidationError("Invalid date");
  if (t < f) throw new ValidationError("The end date is before the start date");
  if (t.diff(f, "days").days > 366) throw new ValidationError("Choose a period of at most one year");
  return { from: f.toISODate()!, to: t.toISODate()!, timezone };
}

/** Bounds as timestamptz parameters: [start of from-day, start of the day after to). */
function bounds(r: Range) {
  return [
    DateTime.fromISO(r.from, { zone: r.timezone }).startOf("day").toJSDate(),
    DateTime.fromISO(r.to, { zone: r.timezone }).plus({ days: 1 }).startOf("day").toJSDate(),
  ] as const;
}

export async function lessonSummary(tx: Tx, r: Range) {
  const [start, end] = bounds(r);
  return one<{ completed: number; no_show: number; cancelled: number; planned: number; hours_driven: number; students_taught: number }>(
    tx,
    `SELECT count(*) FILTER (WHERE status = 'completed')::int AS completed,
            count(*) FILTER (WHERE status = 'no_show')::int AS no_show,
            count(*) FILTER (WHERE status = 'cancelled')::int AS cancelled,
            count(*) FILTER (WHERE status IN ('scheduled','confirmed','in_progress'))::int AS planned,
            COALESCE(round(sum(extract(epoch FROM end_time - start_time)) FILTER (WHERE status = 'completed') / 3600.0, 1), 0)::float AS hours_driven,
            count(DISTINCT student_id) FILTER (WHERE status = 'completed')::int AS students_taught
       FROM lessons WHERE start_time >= $1 AND start_time < $2`,
    [start, end],
  );
}

/**
 * Per instructor: hours they were available (weekly rules and one-off dates,
 * plus "extra time" exceptions, minus time off) against hours booked.
 * Overlapping availability rules are counted once per rule, so keep rules tidy.
 */
export async function instructorUtilisation(tx: Tx, r: Range) {
  const [start, end] = bounds(r);
  return many<{ id: string; name: string; available_hours: number; booked_hours: number; completed_hours: number; utilisation: number | null }>(
    tx,
    `WITH days AS (
       SELECT d::date AS day, extract(isodow FROM d)::int AS dow FROM generate_series($3::date, $4::date, interval '1 day') d
     ),
     rules AS (
       SELECT a.instructor_id, sum(extract(epoch FROM a.end_time - a.start_time)) AS secs
         FROM instructor_availability a JOIN days ON (a.is_recurring AND a.weekday = days.dow
                                                     AND (a.valid_from IS NULL OR days.day >= a.valid_from)
                                                     AND (a.valid_until IS NULL OR days.day <= a.valid_until))
                                                  OR (NOT a.is_recurring AND a.specific_date = days.day)
        GROUP BY a.instructor_id
     ),
     exc AS (
       SELECT instructor_id,
              sum(extract(epoch FROM least(ends_at, $2) - greatest(starts_at, $1)) * CASE WHEN kind = 'available' THEN 1 ELSE -1 END) AS secs
         FROM instructor_availability_exceptions WHERE starts_at < $2 AND ends_at > $1
        GROUP BY instructor_id
     ),
     booked AS (
       SELECT instructor_id,
              sum(extract(epoch FROM end_time - start_time)) FILTER (WHERE status IN ('scheduled','confirmed','in_progress','completed','no_show')) AS booked_secs,
              sum(extract(epoch FROM end_time - start_time)) FILTER (WHERE status = 'completed') AS completed_secs
         FROM lessons WHERE start_time >= $1 AND start_time < $2 GROUP BY instructor_id
     )
     SELECT i.id, i.first_name || ' ' || i.last_name AS name,
            round(greatest(COALESCE(rules.secs, 0) + COALESCE(exc.secs, 0), 0) / 3600.0, 1)::float AS available_hours,
            round(COALESCE(booked.booked_secs, 0) / 3600.0, 1)::float AS booked_hours,
            round(COALESCE(booked.completed_secs, 0) / 3600.0, 1)::float AS completed_hours,
            CASE WHEN COALESCE(rules.secs, 0) + COALESCE(exc.secs, 0) > 0
                 THEN round(100.0 * COALESCE(booked.booked_secs, 0) / (COALESCE(rules.secs, 0) + COALESCE(exc.secs, 0)))::float END AS utilisation
       FROM instructors i
       LEFT JOIN rules ON rules.instructor_id = i.id
       LEFT JOIN exc ON exc.instructor_id = i.id
       LEFT JOIN booked ON booked.instructor_id = i.id
      WHERE i.status = 'active' OR booked.booked_secs IS NOT NULL
      ORDER BY i.first_name`,
    [start, end, r.from, r.to],
  );
}

export async function revenueSummary(tx: Tx, r: Range) {
  const [start, end] = bounds(r);
  const received = await one<{ gross_cents: number; payments: number; online_cents: number; manual_cents: number; vat_cents: number }>(
    tx,
    `SELECT COALESCE(sum(p.amount_cents), 0)::int AS gross_cents, count(*)::int AS payments,
            COALESCE(sum(p.amount_cents) FILTER (WHERE p.recorded_by IS NULL), 0)::int AS online_cents,
            COALESCE(sum(p.amount_cents) FILTER (WHERE p.recorded_by IS NOT NULL), 0)::int AS manual_cents,
            COALESCE(sum(i.tax_cents), 0)::int AS vat_cents
       FROM payments p LEFT JOIN invoices i ON i.id = p.invoice_id
      WHERE p.status IN ('paid','refunded','disputed') AND p.paid_at >= $1 AND p.paid_at < $2`,
    [start, end],
  );
  const refunded = await one<{ cents: number; n: number }>(
    tx,
    `SELECT COALESCE(sum(amount_cents), 0)::int AS cents, count(*)::int AS n FROM payments WHERE status = 'refunded' AND refunded_at >= $1 AND refunded_at < $2`,
    [start, end],
  );
  // Point-in-time figures (now), not limited to the range.
  const open = await one<{ open_cents: number; overdue_cents: number; disputed_cents: number }>(
    tx,
    `SELECT COALESCE(sum(amount_cents) FILTER (WHERE status IN ('pending','failed')), 0)::int AS open_cents,
            COALESCE(sum(amount_cents) FILTER (WHERE status = 'overdue'), 0)::int AS overdue_cents,
            COALESCE(sum(amount_cents) FILTER (WHERE status = 'disputed'), 0)::int AS disputed_cents
       FROM payments`,
  );
  const credits = await one<{ lessons: number }>(tx, `SELECT COALESCE(sum(delta), 0)::int AS lessons FROM student_credit_ledger`);
  return {
    ...received!,
    refunded_cents: refunded!.cents,
    refunds: refunded!.n,
    net_cents: received!.gross_cents - refunded!.cents,
    ...open!,
    prepaid_lessons_outstanding: credits!.lessons,
  };
}

export async function studentSummary(tx: Tx, r: Range) {
  const [start, end] = bounds(r);
  return one<{ new_students: number; active: number; leads: number; completed: number }>(
    tx,
    `SELECT count(*) FILTER (WHERE created_at >= $1 AND created_at < $2)::int AS new_students,
            count(*) FILTER (WHERE status = 'active')::int AS active,
            count(*) FILTER (WHERE status = 'lead')::int AS leads,
            count(*) FILTER (WHERE status = 'completed')::int AS completed
       FROM students WHERE erased_at IS NULL`,
    [start, end],
  );
}

/** One row per payment event in the range, for the accountant / bank reconciliation. */
export async function reconciliationRows(tx: Tx, r: Range) {
  const [start, end] = bounds(r);
  return many<{
    event: "paid" | "refunded";
    at: Date;
    invoice_number: string | null;
    student_number: string;
    bill_to: string | null;
    gross_cents: number;
    vat_cents: number;
    currency: string;
    method: string;
    provider_payment_id: string | null;
    reference: string;
    status_now: string;
  }>(
    tx,
    `SELECT * FROM (
       SELECT 'paid' AS event, p.paid_at AS at, i.invoice_number, s.student_number, i.bill_to_name AS bill_to, p.amount_cents AS gross_cents,
              COALESCE(i.tax_cents, 0) AS vat_cents, p.currency, CASE WHEN p.recorded_by IS NULL THEN p.provider ELSE 'manual' END AS method,
              p.provider_payment_id, p.reference, p.status AS status_now
         FROM payments p JOIN students s ON s.id = p.student_id LEFT JOIN invoices i ON i.id = p.invoice_id
        WHERE p.status IN ('paid','refunded','disputed') AND p.paid_at >= $1 AND p.paid_at < $2
       UNION ALL
       SELECT 'refunded', p.refunded_at, i.invoice_number, s.student_number, i.bill_to_name, -p.amount_cents,
              -COALESCE(i.tax_cents, 0), p.currency, CASE WHEN p.recorded_by IS NULL THEN p.provider ELSE 'manual' END,
              p.provider_payment_id, p.reference, p.status
         FROM payments p JOIN students s ON s.id = p.student_id LEFT JOIN invoices i ON i.id = p.invoice_id
        WHERE p.status = 'refunded' AND p.refunded_at >= $1 AND p.refunded_at < $2
     ) x ORDER BY at`,
    [start, end],
  );
}

/** RFC 4180 CSV; cells that start with = + - @ are prefixed so spreadsheets don't run them as formulas. */
export function toCsv(header: string[], rows: Array<Array<string | number | null>>): string {
  const cell = (v: string | number | null) => {
    if (v === null || v === undefined) return "";
    let s = String(v);
    if (typeof v === "string" && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [header, ...rows].map((r) => r.map(cell).join(",")).join("\r\n") + "\r\n";
}
