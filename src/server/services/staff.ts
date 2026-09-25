import { z } from "zod";
import { many, one, type Tx } from "@/lib/db";
import { ForbiddenError, ValidationError } from "@/lib/errors";
import { can } from "@/lib/rbac";
import type { Principal } from "../principal";
import { audit } from "./audit";
import { inviteUser } from "./students";

function requirePerm(p: Principal, perm: Parameters<typeof can>[1]) {
  if (p.type === "user" && !can(p.actor.role, perm)) throw new ForbiddenError();
}

export const instructorSchema = z.object({
  firstName: z.string().trim().min(1),
  lastName: z.string().trim().min(1),
  email: z.string().email(),
  phone: z.string().max(40).optional(),
  licenseCategories: z.array(z.string().min(1).max(5)).min(1).default(["B"]),
  defaultVehicleId: z.string().uuid().optional().or(z.literal("").transform(() => undefined)),
  color: z.string().regex(/^#[0-9a-f]{6}$/i).optional(),
  createLogin: z.boolean().default(true),
});

export async function createInstructor(tx: Tx, p: Principal, raw: z.input<typeof instructorSchema>) {
  requirePerm(p, "instructors:write");
  const i = instructorSchema.parse(raw);
  const userId = i.createLogin
    ? await inviteUser(tx, p, { role: "instructor", email: i.email, phone: i.phone, notificationType: "user_invite", name: i.firstName })
    : null;
  const row = (await one<{ id: string }>(
    tx,
    `INSERT INTO instructors (school_id, user_id, first_name, last_name, email, phone, license_categories, default_vehicle_id, color)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
    [p.schoolId, userId, i.firstName, i.lastName, i.email, i.phone ?? null, i.licenseCategories, i.defaultVehicleId ?? null, i.color ?? null],
  ))!;
  await audit(tx, p, "instructor.created", "instructor", row.id);
  return row;
}

/**
 * Small schools: the owner is often also the only instructor. This links the
 * owner's own user to an instructor profile so they get the calendar too.
 */
export async function makeOwnerAnInstructor(tx: Tx, p: Principal) {
  if (p.type !== "user" || !["school_owner", "school_admin"].includes(p.actor.role)) throw new ForbiddenError();
  const existing = await one(tx, `SELECT 1 FROM instructors WHERE user_id = $1`, [p.actor.userId]);
  if (existing) return;
  await tx.query(
    `INSERT INTO instructors (school_id, user_id, first_name, last_name, email) VALUES ($1,$2,split_part($3,'@',1),'',$3)`,
    [p.schoolId, p.actor.userId, p.actor.email],
  );
  await audit(tx, p, "instructor.owner_linked", "user", p.actor.userId);
}

export const vehicleSchema = z.object({
  registrationNumber: z.string().trim().min(1).max(20),
  brand: z.string().trim().min(1),
  model: z.string().trim().min(1),
  transmission: z.enum(["manual", "automatic"]),
  vehicleType: z.enum(["car", "motorcycle", "truck", "bus", "trailer", "other"]).default("car"),
  licenseCategory: z.string().trim().min(1).max(5).default("B"),
});

export async function createVehicle(tx: Tx, p: Principal, raw: z.input<typeof vehicleSchema>) {
  requirePerm(p, "vehicles:write");
  const v = vehicleSchema.parse(raw);
  const row = (await one<{ id: string }>(
    tx,
    `INSERT INTO vehicles (school_id, registration_number, brand, model, transmission, vehicle_type, license_category)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
    [p.schoolId, v.registrationNumber.toUpperCase(), v.brand, v.model, v.transmission, v.vehicleType, v.licenseCategory],
  ))!;
  await audit(tx, p, "vehicle.created", "vehicle", row.id);
  return row;
}

export async function setVehicleStatus(tx: Tx, p: Principal, vehicleId: string, status: "active" | "maintenance" | "retired") {
  requirePerm(p, "vehicles:write");
  await tx.query(`UPDATE vehicles SET status = $2 WHERE id = $1`, [vehicleId, status]);
  await audit(tx, p, "vehicle.status_changed", "vehicle", vehicleId, { status });
}

export const availabilityRuleSchema = z.object({
  instructorId: z.string().uuid(),
  isRecurring: z.boolean(),
  weekday: z.number().int().min(1).max(7).optional(),
  specificDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  start: z.string().regex(/^\d{2}:\d{2}$/),
  end: z.string().regex(/^\d{2}:\d{2}$/),
  validFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  validUntil: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
});

function assertOwnAvailability(p: Principal, instructorId: string) {
  if (p.type !== "user") return;
  if (can(p.actor.role, "availability:write_all")) return;
  if (can(p.actor.role, "availability:write_own") && p.actor.instructorId === instructorId) return;
  throw new ForbiddenError();
}

export async function addAvailabilityRule(tx: Tx, p: Principal, raw: z.input<typeof availabilityRuleSchema>) {
  const r = availabilityRuleSchema.parse(raw);
  assertOwnAvailability(p, r.instructorId);
  if (r.end <= r.start) throw new ValidationError("End time must be after start time");
  await tx.query(
    `INSERT INTO instructor_availability (school_id, instructor_id, is_recurring, weekday, specific_date, start_time, end_time, valid_from, valid_until)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [p.schoolId, r.instructorId, r.isRecurring, r.isRecurring ? r.weekday : null, r.isRecurring ? null : r.specificDate, r.start, r.end, r.validFrom ?? null, r.validUntil ?? null],
  );
  await audit(tx, p, "availability.rule_added", "instructor", r.instructorId, r);
}

export async function deleteAvailabilityRule(tx: Tx, p: Principal, ruleId: string) {
  const rule = await one<{ instructor_id: string }>(tx, `SELECT instructor_id FROM instructor_availability WHERE id = $1`, [ruleId]);
  if (!rule) return;
  assertOwnAvailability(p, rule.instructor_id);
  await tx.query(`DELETE FROM instructor_availability WHERE id = $1`, [ruleId]);
  await audit(tx, p, "availability.rule_deleted", "instructor", rule.instructor_id, { ruleId });
}

export async function addAvailabilityException(
  tx: Tx,
  p: Principal,
  args: { instructorId: string; kind: "available" | "unavailable"; startsAt: Date; endsAt: Date; reason?: string },
) {
  assertOwnAvailability(p, args.instructorId);
  if (args.endsAt <= args.startsAt) throw new ValidationError("End must be after start");
  await tx.query(
    `INSERT INTO instructor_availability_exceptions (school_id, instructor_id, kind, starts_at, ends_at, reason) VALUES ($1,$2,$3,$4,$5,$6)`,
    [p.schoolId, args.instructorId, args.kind, args.startsAt, args.endsAt, args.reason ?? null],
  );
  await audit(tx, p, "availability.exception_added", "instructor", args.instructorId, { kind: args.kind });
}

export async function listInstructorAvailability(tx: Tx, instructorId: string) {
  return many<{ id: string; is_recurring: boolean; weekday: number | null; specific_date: string | null; start_time: string; end_time: string }>(
    tx,
    `SELECT id, is_recurring, weekday, specific_date::text, to_char(start_time,'HH24:MI') AS start_time, to_char(end_time,'HH24:MI') AS end_time
       FROM instructor_availability WHERE instructor_id = $1 ORDER BY is_recurring DESC, weekday, specific_date, start_time`,
    [instructorId],
  );
}
