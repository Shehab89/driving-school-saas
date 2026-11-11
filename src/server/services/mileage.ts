/**
 * Mileage log (kilometerregistratie). A self-employed instructor who drives a
 * business car must be able to show the tax office, per trip: the date, the
 * odometer at the start and the end, where from and where to, and whether
 * the trip was business or private. Each instructor keeps their own log; the
 * school owner can export everyone's.
 */
import { z } from "zod";
import { DateTime } from "luxon";
import { many, one, type Tx } from "@/lib/db";
import { ConflictError, ForbiddenError, NotFoundError, PolicyError, ValidationError } from "@/lib/errors";
import { can } from "@/lib/rbac";
import type { Principal } from "../principal";
import { audit } from "./audit";

export const PURPOSES = ["business", "commute", "private"] as const;
export type Purpose = (typeof PURPOSES)[number];

const entrySchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  vehicleId: z.string().uuid().nullish(),
  startKm: z.coerce.number().int().min(0).max(9_999_999),
  endKm: z.coerce.number().int().min(0).max(9_999_999),
  fromPlace: z.string().trim().max(200).nullish(),
  toPlace: z.string().trim().max(200).nullish(),
  purpose: z.enum(PURPOSES).default("business"),
  note: z.string().trim().max(200).nullish(),
});
export type MileageInput = z.input<typeof entrySchema>;

export interface MileageRow {
  id: string;
  trip_date: string;
  instructor_id: string;
  instructor: string;
  vehicle_id: string | null;
  vehicle: string | null;
  registration_number: string | null;
  start_km: number;
  end_km: number;
  km: number;
  from_place: string | null;
  to_place: string | null;
  purpose: Purpose;
  note: string | null;
}

function ownInstructor(p: Principal): string {
  if (p.type !== "user" || !p.actor.instructorId) throw new ForbiddenError("Only an instructor keeps a mileage log.");
  return p.actor.instructorId;
}

/** Whose log may p read: their own, or (school staff) anyone's. */
export function mileageScope(p: Principal, instructorId: string | null): string | null {
  if (p.type !== "user") throw new ForbiddenError();
  if (can(p.actor.role, "instructors:write")) return instructorId;
  if (!p.actor.instructorId || (instructorId && instructorId !== p.actor.instructorId)) throw new ForbiddenError();
  return p.actor.instructorId;
}

export async function addMileage(tx: Tx, p: Principal, raw: MileageInput, timezone: string): Promise<{ id: string; km: number }> {
  const instructorId = ownInstructor(p);
  const e = entrySchema.parse(raw);
  const day = DateTime.fromISO(e.date, { zone: timezone });
  if (!day.isValid) throw new ValidationError("Invalid date");
  if (day > DateTime.now().setZone(timezone).endOf("day")) throw new PolicyError("A trip cannot be in the future.", "mileage_future");
  if (e.endKm < e.startKm) throw new PolicyError("The end reading is lower than the start reading.", "mileage_backwards");
  if (e.endKm - e.startKm > 2000) throw new PolicyError("More than 2000 km in one trip: check the readings.", "mileage_too_long");
  if (e.vehicleId) {
    if (!(await one(tx, `SELECT 1 FROM vehicles WHERE id = $1`, [e.vehicleId]))) throw new NotFoundError("Vehicle");
    // The same stretch of the odometer cannot be written down twice (a typo, or the trip was already logged).
    const clash = await one<{ trip_date: string; start_km: number; end_km: number }>(
      tx,
      `SELECT to_char(trip_date, 'YYYY-MM-DD') AS trip_date, start_km, end_km FROM mileage_entries
        WHERE vehicle_id = $1 AND start_km < $3 AND end_km > $2 LIMIT 1`,
      [e.vehicleId, e.startKm, e.endKm],
    );
    if (clash) throw new ConflictError(`These kilometres are already in the log (${clash.trip_date}: ${clash.start_km}–${clash.end_km}).`, "mileage_overlap", { date: clash.trip_date, from: clash.start_km, to: clash.end_km });
  }
  const r = await one<{ id: string }>(
    tx,
    `INSERT INTO mileage_entries (school_id, instructor_id, vehicle_id, trip_date, start_km, end_km, from_place, to_place, purpose, note, created_by)
     VALUES (current_setting('app.school_id')::uuid, $1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
    [instructorId, e.vehicleId ?? null, e.date, e.startKm, e.endKm, e.fromPlace || null, e.toPlace || null, e.purpose, e.note || null, p.type === "user" ? p.actor.userId : null],
  );
  await audit(tx, p, "mileage.added", "mileage_entry", r!.id, { km: e.endKm - e.startKm, purpose: e.purpose });
  return { id: r!.id, km: e.endKm - e.startKm };
}

export async function deleteMileage(tx: Tx, p: Principal, id: string) {
  const instructorId = ownInstructor(p);
  const r = await tx.query(`DELETE FROM mileage_entries WHERE id = $1 AND instructor_id = $2`, [id, instructorId]);
  if (!r.rowCount) throw new NotFoundError("Trip");
  await audit(tx, p, "mileage.deleted", "mileage_entry", id);
}

export async function listMileage(tx: Tx, instructorId: string | null, from: string, to: string): Promise<MileageRow[]> {
  return many<MileageRow>(
    tx,
    `SELECT m.id, to_char(m.trip_date, 'YYYY-MM-DD') AS trip_date, m.instructor_id, i.first_name || ' ' || i.last_name AS instructor,
            m.vehicle_id, CASE WHEN v.id IS NULL THEN NULL ELSE v.brand || ' ' || v.model END AS vehicle, v.registration_number,
            m.start_km, m.end_km, m.end_km - m.start_km AS km, m.from_place, m.to_place, m.purpose, m.note
       FROM mileage_entries m JOIN instructors i ON i.id = m.instructor_id LEFT JOIN vehicles v ON v.id = m.vehicle_id
      WHERE m.trip_date BETWEEN $1 AND $2 AND ($3::uuid IS NULL OR m.instructor_id = $3)
      ORDER BY m.trip_date DESC, m.start_km DESC
      LIMIT 5000`,
    [from, to, instructorId],
  );
}

export function mileageTotals(rows: Pick<MileageRow, "km" | "purpose">[]): Record<Purpose | "total", number> {
  const t = { business: 0, commute: 0, private: 0, total: 0 };
  for (const r of rows) {
    t[r.purpose] += r.km;
    t.total += r.km;
  }
  return t;
}

/**
 * What the form can fill in for a day: the instructor's car, its last
 * odometer reading, and where the day's lessons started and ended.
 */
export async function mileageSuggestion(tx: Tx, instructorId: string, date: string, timezone: string) {
  const i = await one<{ vehicle_id: string | null }>(tx, `SELECT default_vehicle_id AS vehicle_id FROM instructors WHERE id = $1`, [instructorId]);
  const last = await one<{ vehicle_id: string | null; end_km: number }>(
    tx,
    `SELECT vehicle_id, end_km FROM mileage_entries
      WHERE (vehicle_id = $2 OR ($2::uuid IS NULL AND instructor_id = $1))
      ORDER BY end_km DESC LIMIT 1`,
    [instructorId, i?.vehicle_id ?? null],
  );
  const day = DateTime.fromISO(date, { zone: timezone });
  const lessons = await many<{ pickup_address: string | null; dropoff_address: string | null }>(
    tx,
    `SELECT pickup_address, dropoff_address FROM lessons
      WHERE instructor_id = $1 AND start_time >= $2 AND start_time < $3 AND status IN ('scheduled','confirmed','in_progress','completed')
      ORDER BY start_time`,
    [instructorId, day.startOf("day").toJSDate(), day.plus({ days: 1 }).startOf("day").toJSDate()],
  );
  return {
    vehicleId: i?.vehicle_id ?? last?.vehicle_id ?? null,
    startKm: last?.end_km ?? null,
    fromPlace: lessons[0]?.pickup_address ?? null,
    toPlace: lessons.at(-1)?.dropoff_address ?? lessons.at(-1)?.pickup_address ?? null,
    lessons: lessons.length,
  };
}
