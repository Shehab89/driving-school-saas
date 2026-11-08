/**
 * Where a lesson starts and ends (pure; no I/O).
 *
 * The student has a usual pick-up place (and maybe a different drop-off).
 * Before a lesson, the instructor drives from where their previous lesson
 * ends. When that drive does not fit in the gap, the lesson starts where the
 * previous one ends instead ("meet at the previous student's end point").
 * Likewise, when the drive to the next lesson does not fit, the lesson ends
 * where the next one starts. Lessons already booked are never changed.
 */
import { hasPoint, travelMinutes, type Point } from "@/lib/travel";

export interface MaybePlace { address: string | null; lat: number | null; lng: number | null }
export interface PlacedLesson { start: Date; end: Date; pickup: MaybePlace; dropoff: MaybePlace }
export type PickupSource = "student" | "previous_lesson";
export type DropoffSource = "student" | "next_lesson";

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

export function planPlaces(input: {
  studentPickup: MaybePlace | null;
  studentDropoff: MaybePlace | null;
  start: Date;
  end: Date;
  /** The same instructor's other lessons that day. */
  others: PlacedLesson[];
  speedKmh: number;
}): PlacePlan {
  const home = known(input.studentPickup) ? input.studentPickup : null;
  const drop = known(input.studentDropoff) ? input.studentDropoff : home;
  const plan: PlacePlan = { pickup: home, pickupSource: "student", dropoff: drop, dropoffSource: "student", travelBefore: null };

  const prev = input.others.filter((l) => l.end.getTime() <= input.start.getTime()).sort((a, b) => b.end.getTime() - a.end.getTime())[0];
  const next = input.others.filter((l) => l.start.getTime() >= input.end.getTime()).sort((a, b) => a.start.getTime() - b.start.getTime())[0];

  if (prev) {
    const from = endPoint(prev);
    const a = pt(from), b = pt(home);
    if (a && b) {
      const need = travelMinutes(a, b, input.speedKmh);
      const gap = (input.start.getTime() - prev.end.getTime()) / 60_000;
      if (need > gap) Object.assign(plan, { pickup: from, pickupSource: "previous_lesson", travelBefore: 0 });
      else plan.travelBefore = need;
    } else if (a && !home) {
      // The student has no address yet: start where the instructor already is.
      Object.assign(plan, { pickup: from, pickupSource: "previous_lesson", travelBefore: 0 });
    }
  }
  if (next && known(next.pickup)) {
    const a = pt(plan.dropoff), b = pt(next.pickup);
    const gap = (next.start.getTime() - input.end.getTime()) / 60_000;
    if (a && b && travelMinutes(a, b, input.speedKmh) > gap) Object.assign(plan, { dropoff: next.pickup, dropoffSource: "next_lesson" });
  }
  return plan;
}
