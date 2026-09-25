/**
 * Scheduling engine (pure; no I/O). Computes bookable lesson slots.
 *
 * A slot [t, t + duration) is offered only when ALL of these hold:
 *   - the school is open (weekly opening hours, minus closure days)
 *   - the instructor is available (weekly/one-off rules + "available"
 *     exceptions, minus "unavailable" exceptions)
 *   - the instructor has no other lesson overlapping (with buffer)
 *   - a compatible vehicle is free (with buffer), when a vehicle is required
 *   - the student has no other lesson overlapping
 *   - it is within the student's preferred availability (when they set any)
 *   - it starts at least `minLeadMinutes` from now
 *
 * All wall-clock rules are evaluated in the school's IANA timezone, so DST
 * changes are handled (a 09:00 rule is 09:00 local on both sides of a change).
 *
 * The engine only *proposes* slots. Bookings are re-validated inside a
 * transaction and the database exclusion constraints are the final guard
 * against races (see db/migrations/001_core_schema.sql, lessons table).
 */
import { DateTime } from "luxon";
import { expand, intersect, normalize, overlapsAny, subtract, type Interval } from "./intervals";
import { localToMillis } from "@/lib/time";

export interface WeeklyWindow {
  weekday: number; // ISO 1 = Monday … 7 = Sunday
  start: string; // "HH:MM" local
  end: string;
}

export interface AvailabilityRule {
  isRecurring: boolean;
  weekday?: number | null;
  specificDate?: string | null; // YYYY-MM-DD
  start: string;
  end: string;
  validFrom?: string | null;
  validUntil?: string | null;
}

export interface TimeRange {
  start: Date;
  end: Date;
}

export interface InstructorInput {
  id: string;
  rules: AvailabilityRule[];
  exceptions: Array<TimeRange & { kind: "available" | "unavailable" }>;
  busy: TimeRange[]; // existing lessons
  defaultVehicleId?: string | null;
}

export interface VehicleInput {
  id: string;
  busy: TimeRange[]; // lessons (buffer applied by engine)
  blocked?: TimeRange[]; // maintenance windows (no buffer)
}

export interface SlotSearchInput {
  timezone: string;
  from: Date;
  to: Date;
  now: Date;
  durationMinutes: number;
  granularityMinutes: number;
  bufferMinutes: number;
  minLeadMinutes: number;
  openingHours: WeeklyWindow[];
  closures: Array<{ startsOn: string; endsOn: string }>;
  instructors: InstructorInput[];
  vehicles: VehicleInput[]; // already filtered to vehicles compatible with the student
  requireVehicle: boolean;
  studentBusy: TimeRange[];
  studentPreferences?: WeeklyWindow[];
  preferredInstructorId?: string | null;
  /** Return one slot per start time (the best instructor/vehicle for it). */
  distinctTimes?: boolean;
  maxSlots?: number;
}

export interface Slot {
  start: Date;
  end: Date;
  instructorId: string;
  vehicleId: string | null;
}

const MIN = 60_000;

function toIntervals(ranges: TimeRange[]): Interval[] {
  return ranges.map((r) => ({ start: r.start.getTime(), end: r.end.getTime() }));
}

function windowsOnDate(windows: WeeklyWindow[], isoDate: string, weekday: number, zone: string): Interval[] {
  return windows
    .filter((w) => w.weekday === weekday)
    .map((w) => ({ start: localToMillis(isoDate, w.start, zone), end: localToMillis(isoDate, w.end, zone) }));
}

function ruleApplies(rule: AvailabilityRule, isoDate: string, weekday: number): boolean {
  if (!rule.isRecurring) return rule.specificDate === isoDate;
  if (rule.weekday !== weekday) return false;
  if (rule.validFrom && isoDate < rule.validFrom) return false;
  if (rule.validUntil && isoDate > rule.validUntil) return false;
  return true;
}

/** Round t up to the local-time grid (multiples of granularity since local midnight). */
function alignUp(t: number, granularityMin: number, zone: string): number {
  const local = DateTime.fromMillis(t, { zone });
  const midnight = local.startOf("day");
  const minutes = Math.ceil(local.diff(midnight, "minutes").minutes - 1e-9);
  const aligned = Math.ceil(minutes / granularityMin) * granularityMin;
  return midnight.plus({ minutes: aligned }).toMillis();
}

export function findAvailableSlots(input: SlotSearchInput): Slot[] {
  const zone = input.timezone;
  const dur = input.durationMinutes * MIN;
  const buffer = input.bufferMinutes * MIN;
  const earliest = Math.max(input.from.getTime(), input.now.getTime() + input.minLeadMinutes * MIN);
  const latest = input.to.getTime();
  if (latest - earliest < dur) return [];

  const studentBusy = normalize(toIntervals(input.studentBusy));
  const vehicles = input.vehicles.map((v) => ({
    id: v.id,
    busy: normalize([...expand(toIntervals(v.busy), buffer), ...toIntervals(v.blocked ?? [])]),
  }));
  const instructors = [...input.instructors].sort((a, b) =>
    a.id === input.preferredInstructorId ? -1 : b.id === input.preferredInstructorId ? 1 : 0,
  );

  const slots: Slot[] = [];
  let day = DateTime.fromMillis(earliest, { zone }).startOf("day");
  const lastDay = DateTime.fromMillis(latest, { zone }).startOf("day");

  for (; day <= lastDay; day = day.plus({ days: 1 })) {
    const isoDate = day.toISODate()!;
    const weekday = day.weekday;
    if (input.closures.some((c) => isoDate >= c.startsOn && isoDate <= c.endsOn)) continue;

    let open = windowsOnDate(input.openingHours, isoDate, weekday, zone);
    open = intersect(open, [{ start: earliest, end: latest }]);
    if (input.studentPreferences && input.studentPreferences.length > 0) {
      open = intersect(open, windowsOnDate(input.studentPreferences, isoDate, weekday, zone));
    }
    open = subtract(open, studentBusy);
    if (open.length === 0) continue;

    const daySlots: Slot[] = [];
    for (const ins of instructors) {
      const ruleWindows = ins.rules
        .filter((r) => ruleApplies(r, isoDate, weekday))
        .map((r) => ({ start: localToMillis(isoDate, r.start, zone), end: localToMillis(isoDate, r.end, zone) }));
      const extra = toIntervals(ins.exceptions.filter((e) => e.kind === "available"));
      const blocked = toIntervals(ins.exceptions.filter((e) => e.kind === "unavailable"));
      let free = subtract(normalize([...ruleWindows, ...extra]), blocked);
      free = intersect(free, open);
      free = subtract(free, expand(toIntervals(ins.busy), buffer));

      for (const w of free) {
        for (let t = alignUp(w.start, input.granularityMinutes, zone); t + dur <= w.end; t += input.granularityMinutes * MIN) {
          let vehicleId: string | null = null;
          if (input.requireVehicle) {
            const ordered = ins.defaultVehicleId
              ? [...vehicles].sort((a, b) => (a.id === ins.defaultVehicleId ? -1 : b.id === ins.defaultVehicleId ? 1 : 0))
              : vehicles;
            const v = ordered.find((veh) => !overlapsAny(veh.busy, t, t + dur));
            if (!v) continue;
            vehicleId = v.id;
          }
          daySlots.push({ start: new Date(t), end: new Date(t + dur), instructorId: ins.id, vehicleId });
        }
      }
    }

    // Stable sort keeps preferred-instructor slots first at equal start times.
    daySlots.sort((a, b) => a.start.getTime() - b.start.getTime());
    for (const s of daySlots) {
      if (input.distinctTimes && slots.length > 0 && slots[slots.length - 1]!.start.getTime() === s.start.getTime()) continue;
      slots.push(s);
      if (input.maxSlots && slots.length >= input.maxSlots) return slots;
    }
  }
  return slots;
}

/** True when exactly this slot (same instructor, start, end; same vehicle if given) would be offered. */
export function isSlotAvailable(input: Omit<SlotSearchInput, "from" | "to" | "distinctTimes" | "maxSlots">, slot: Slot): boolean {
  const found = findAvailableSlots({
    ...input,
    from: slot.start,
    to: slot.end,
    durationMinutes: Math.round((slot.end.getTime() - slot.start.getTime()) / MIN),
    instructors: input.instructors.filter((i) => i.id === slot.instructorId),
    vehicles: slot.vehicleId ? input.vehicles.filter((v) => v.id === slot.vehicleId) : input.vehicles,
  });
  return found.some((s) => s.start.getTime() === slot.start.getTime());
}
