import { describe, expect, it } from "vitest";
import { planPlaces, type MaybePlace, type PlacedLesson } from "@/server/scheduling/places";
import { publicPlace, travelMinutes } from "@/lib/travel";

const utrechtC = { address: "Stationsplein 1, Utrecht", lat: 52.0894, lng: 5.1101 };
const utrechtNorth = { address: "Kerkstraat 12, Utrecht", lat: 52.1, lng: 5.12 };
const amsterdam = { address: "Damrak 1, 1012LG Amsterdam", lat: 52.3759, lng: 4.8975 };
const none: MaybePlace = { address: null, lat: null, lng: null };
const at = (h: number, m = 0) => new Date(Date.UTC(2026, 10, 10, h, m));
const lesson = (startH: number, endH: number, pickup: MaybePlace = utrechtC, dropoff: MaybePlace = none): PlacedLesson => ({ start: at(startH), end: at(endH), pickup, dropoff });

describe("travel time", () => {
  it("is zero for the same place and grows with distance", () => {
    expect(travelMinutes(utrechtC, utrechtC)).toBe(0);
    expect(travelMinutes(utrechtC, utrechtNorth)).toBeLessThan(15);
    const far = travelMinutes(utrechtC, amsterdam);
    expect(far).toBeGreaterThan(35);
    expect(far).toBeLessThan(70);
  });

  it("hides the house number and postcode when showing someone else's place", () => {
    expect(publicPlace("Damrak 1, 1012LG Amsterdam")).toBe("Damrak, Amsterdam");
    expect(publicPlace("Kerkstraat 12a, 3511 AB Utrecht")).toBe("Kerkstraat, Utrecht");
  });
});

describe("where a lesson starts and ends", () => {
  it("starts at the student's place when there is time to drive there", () => {
    const p = planPlaces({ studentPickup: utrechtNorth, studentDropoff: null, start: at(10), end: at(11), others: [lesson(8, 9)], speedKmh: 30 });
    expect(p).toMatchObject({ pickup: utrechtNorth, pickupSource: "student", dropoff: utrechtNorth, dropoffSource: "student" });
    expect(p.travelBefore).toBeGreaterThan(0);
  });

  it("meets at the previous student's end point when the gap is too short", () => {
    const p = planPlaces({ studentPickup: amsterdam, studentDropoff: null, start: at(9), end: at(10), others: [lesson(8, 9, utrechtC, utrechtNorth)], speedKmh: 30 });
    expect(p).toMatchObject({ pickup: utrechtNorth, pickupSource: "previous_lesson", travelBefore: 0 });
    // The student still goes home afterwards.
    expect(p.dropoff).toEqual(amsterdam);
  });

  it("ends where the next lesson starts when there is no time to drive on", () => {
    const p = planPlaces({ studentPickup: amsterdam, studentDropoff: null, start: at(8), end: at(9), others: [lesson(9, 10, utrechtC)], speedKmh: 30 });
    expect(p).toMatchObject({ pickup: amsterdam, pickupSource: "student", dropoff: utrechtC, dropoffSource: "next_lesson" });
  });

  it("does nothing clever when addresses are unknown", () => {
    const p = planPlaces({ studentPickup: none, studentDropoff: null, start: at(10), end: at(11), others: [lesson(8, 9, none)], speedKmh: 30 });
    expect(p).toMatchObject({ pickup: null, pickupSource: "student", travelBefore: null });
  });

  const school = { address: "Oudegracht 100, Utrecht", lat: null, lng: null };
  const typedOnly = (address: string): MaybePlace => ({ address, lat: null, lng: null });

  it("always gives a start and an end: the school when nothing else is known", () => {
    const p = planPlaces({ studentPickup: none, studentDropoff: null, start: at(10), end: at(11), others: [], speedKmh: 30, school });
    expect(p).toMatchObject({ pickup: school, pickupSource: "school", dropoff: school, dropoffSource: "school" });
  });

  it("a student without an address starts and ends where the instructor already is", () => {
    const p = planPlaces({ studentPickup: none, studentDropoff: null, start: at(9), end: at(10), others: [lesson(8, 9, utrechtC, utrechtNorth)], speedKmh: 30, school });
    expect(p).toMatchObject({ pickup: utrechtNorth, pickupSource: "previous_lesson", dropoff: utrechtNorth, dropoffSource: "previous_lesson" });
  });

  it("back to back at two places without map points: the next lesson starts where the previous one ends", () => {
    const prev = lesson(8, 9, typedOnly("Kerkstraat 1, Zeist"));
    const p = planPlaces({ studentPickup: typedOnly("Dorpsstraat 5, Bunnik"), studentDropoff: null, start: at(9), end: at(10), others: [prev], speedKmh: 30 });
    expect(p).toMatchObject({ pickup: prev.pickup, pickupSource: "previous_lesson" });
  });

  it("with a long gap, an unknown distance is assumed to fit", () => {
    const home = typedOnly("Dorpsstraat 5, Bunnik");
    const p = planPlaces({ studentPickup: home, studentDropoff: null, start: at(10), end: at(11), others: [lesson(8, 9, typedOnly("Kerkstraat 1, Zeist"))], speedKmh: 30 });
    expect(p).toMatchObject({ pickup: home, pickupSource: "student" });
  });

  it("the same typed address counts as the same place (no driving needed)", () => {
    const home = typedOnly("Kerkstraat 1, Zeist");
    const p = planPlaces({ studentPickup: home, studentDropoff: null, start: at(9), end: at(10), others: [lesson(8, 9, typedOnly("kerkstraat 1,  Zeist"))], speedKmh: 30 });
    expect(p).toMatchObject({ pickup: home, pickupSource: "student", travelBefore: 0 });
  });

  it("chains: three lessons back to back far apart all hand over the place", () => {
    const first = planPlaces({ studentPickup: utrechtC, studentDropoff: null, start: at(8), end: at(9), others: [], speedKmh: 30 });
    const l1: PlacedLesson = { start: at(8), end: at(9), pickup: first.pickup!, dropoff: first.dropoff! };
    const second = planPlaces({ studentPickup: amsterdam, studentDropoff: null, start: at(9), end: at(10), others: [l1], speedKmh: 30 });
    expect(second.pickup).toEqual(utrechtC);
    const l2: PlacedLesson = { start: at(9), end: at(10), pickup: second.pickup!, dropoff: second.dropoff! };
    const third = planPlaces({ studentPickup: utrechtNorth, studentDropoff: null, start: at(10), end: at(11), others: [l1, l2], speedKmh: 30 });
    // Lesson 2 ends in Amsterdam (its student's home); no time to drive to Utrecht, so lesson 3 starts in Amsterdam.
    expect(third).toMatchObject({ pickup: amsterdam, pickupSource: "previous_lesson" });
  });
});
