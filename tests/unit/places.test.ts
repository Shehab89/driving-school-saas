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
});
