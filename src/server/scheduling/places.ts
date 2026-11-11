/**
 * Where a lesson starts and ends (pure; no I/O).
 *
 * The student has a usual pick-up place (and maybe a different drop-off).
 * Before a lesson, the instructor drives from where their previous lesson
 * ends. When that drive does not fit in the gap, the lesson starts where the
 * previous one ends instead ("meet at the previous student's end point").
 * Likewise, when the drive to the next lesson does not fit, the lesson ends
 * where the next one starts. Lessons already booked are never changed.
 *
 * Every lesson gets a start and an end place:
 *  - no address for the student → where the instructor already is (previous
 *    lesson's end point), else the school's address;
 *  - the end place is the student's drop-off, else where the lesson started;
 *  - when a distance cannot be worked out (an address without map point) and
 *    the gap is shorter than UNKNOWN_DRIVE_MINUTES, there is assumed to be no
 *    time to drive, so the lesson starts where the previous one ends.
 */
import { hasPoint, travelMinutes, type Point } from "@/lib/travel";

export interface MaybePlace { address: string | null; lat: number | null; lng: number | null }
export interface PlacedLesson { start: Date; end: Date; pickup: MaybePlace; dropoff: MaybePlace }
export type PickupSource = "student" | "previous_lesson" | "school";
/** previous_lesson: no drop-off of their own, so the lesson ends where it started (the previous lesson's end point). */
export type DropoffSource = "student" | "next_lesson" | "previous_lesson" | "school";

/** A gap shorter than this is too short to drive between two different places whose distance is unknown. */
export const UNKNOWN_DRIVE_MINUTES = 15;

export interface PlacePlan {
  pickup: MaybePlace | null;
  pickupSource: PickupSource;
  dropoff: MaybePlace | null;
  dropoffSource: DropoffSource;
  /** Estimated drive from the previous lesson's end point; null when unknown or no earlier lesson that day. */
  travelBefore: number | null;
}

const known = (p: MaybePlace | null | undefined): p is MaybePlace => !!p && !!p.address;
/** Where a booked lesson ends: its drop-off, or where it started. */
export const endPoint = (l: PlacedLesson): MaybePlace | null => (known(l.dropoff) ? l.dropoff : known(l.pickup) ? l.pickup : null);
const pt = (p: MaybePlace | null): Point | null => (p && hasPoint(p) ? { lat: p.lat!, lng: p.lng! } : null);
const norm = (a: string | null) => (a ?? "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
const samePlace = (a: MaybePlace, b: MaybePlace) => norm(a.address) === norm(b.address);

/**
 * Minutes needed to drive from a to b, or null when it is unknown. Two places
 * without map points but with the same address are the same place (0 min).
 */
function driveMinutes(a: MaybePlace, b: MaybePlace, speedKmh: number): number | null {
  const pa = pt(a), pb = pt(b);
  if (pa && pb) return travelMinutes(pa, pb, speedKmh);
  return samePlace(a, b) ? 0 : null;
}
/** Is there time to drive from a to b in the gap? Unknown distances only fit in a long enough gap. */
function fits(a: MaybePlace, b: MaybePlace, gapMinutes: number, speedKmh: number) {
  const need = driveMinutes(a, b, speedKmh);
  return { ok: need === null ? gapMinutes >= UNKNOWN_DRIVE_MINUTES : need <= gapMinutes, need };
}

export function planPlaces(input: {
  studentPickup: MaybePlace | null;
  studentDropoff: MaybePlace | null;
  start: Date;
  end: Date;
  /** The same instructor's other lessons that day. */
  others: PlacedLesson[];
  speedKmh: number;
  /** The school's address: the meeting point when the student has none and there is no earlier lesson. */
  school?: MaybePlace | null;
}): PlacePlan {
  const home = known(input.studentPickup) ? input.studentPickup : null;
  const drop = known(input.studentDropoff) ? input.studentDropoff : home;
  const plan: PlacePlan = { pickup: home, pickupSource: "student", dropoff: drop, dropoffSource: "student", travelBefore: null };

  const prev = input.others.filter((l) => l.end.getTime() <= input.start.getTime()).sort((a, b) => b.end.getTime() - a.end.getTime())[0];
  const next = input.others.filter((l) => l.start.getTime() >= input.end.getTime()).sort((a, b) => a.start.getTime() - b.start.getTime())[0];

  if (prev) {
    const from = endPoint(prev);
    const gap = (input.start.getTime() - prev.end.getTime()) / 60_000;
    if (from && !home) {
      // The student has no address yet: start where the instructor already is.
      Object.assign(plan, { pickup: from, pickupSource: "previous_lesson", travelBefore: 0 });
    } else if (from && home) {
      const f = fits(from, home, gap, input.speedKmh);
      if (!f.ok) Object.assign(plan, { pickup: from, pickupSource: "previous_lesson", travelBefore: 0 });
      else plan.travelBefore = f.need;
    }
  }
  // Still nowhere to meet: the school.
  if (!plan.pickup && known(input.school)) Object.assign(plan, { pickup: input.school, pickupSource: "school" });
  // The lesson ends where the student wants, or else where it started.
  if (!plan.dropoff && plan.pickup) Object.assign(plan, { dropoff: plan.pickup, dropoffSource: plan.pickupSource });
  if (next && known(next.pickup) && plan.dropoff) {
    const gap = (next.start.getTime() - input.end.getTime()) / 60_000;
    if (!fits(plan.dropoff, next.pickup, gap, input.speedKmh).ok) Object.assign(plan, { dropoff: next.pickup, dropoffSource: "next_lesson" });
  }
  return plan;
}
