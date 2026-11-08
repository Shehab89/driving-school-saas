/**
 * Driving time between two places, estimated without a paid maps service:
 * straight-line distance × a road factor ÷ the school's average speed.
 * Good enough to decide "can the instructor get there in the gap?"; it is
 * deliberately a little pessimistic (rounded up, a few minutes to park).
 */
export interface Point { lat: number; lng: number }
export interface Place extends Point { address: string }

/** Roads are rarely straight: a typical Dutch city/regional detour factor. */
export const ROAD_FACTOR = 1.35;
/** Finding the student, parking, swapping seats. */
export const STOP_MINUTES = 3;
/** Closer than this counts as the same place. */
const SAME_PLACE_KM = 0.15;

export function distanceKm(a: Point, b: Point): number {
  const R = 6371;
  const rad = (d: number) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Beyond this many road km the trip is mostly provincial road / motorway. */
const CITY_KM = 5;
const OPEN_ROAD_KMH = 75;

/** Minutes to drive from a to b: the first km at the school's city speed, the rest at open-road speed. */
export function travelMinutes(a: Point, b: Point, citySpeedKmh = 30): number {
  const km = distanceKm(a, b);
  if (km < SAME_PLACE_KM) return 0;
  const road = km * ROAD_FACTOR;
  const minutes = (Math.min(road, CITY_KM) / citySpeedKmh + Math.max(0, road - CITY_KM) / OPEN_ROAD_KMH) * 60;
  return Math.ceil(minutes) + STOP_MINUTES;
}

export const hasPoint = (p: { lat: number | null; lng: number | null } | null | undefined): p is Point =>
  !!p && typeof p.lat === "number" && typeof p.lng === "number";

/**
 * What another student may see of a place: street and town, without the
 * house number (the place can be someone else's home).
 */
export function publicPlace(address: string): string {
  return address
    .replace(/(\p{L}[\p{L}.'\- ]*?)\s+\d+\s*[a-zA-Z]?(?:[-\s]?\d+)?(?=\s*(,|$))/u, "$1")
    .replace(/\b\d{4}\s?[A-Z]{2}\b\s*/, "")
    .replace(/\s+,/g, ",")
    .replace(/,\s*,/g, ",")
    .trim();
}

/** A route link that opens in the phone's maps app (no API key, no cost). */
export function routeUrl(to: Point, from?: Point | null): string {
  const q = new URLSearchParams({ api: "1", destination: `${to.lat},${to.lng}`, travelmode: "driving" });
  if (from) q.set("origin", `${from.lat},${from.lng}`);
  return `https://www.google.com/maps/dir/?${q.toString()}`;
}
