/**
 * Address → coordinates. Default: PDOK Locatieserver, the Dutch government's
 * free address search (no account, no key, no cost). Tests register a fake.
 * A failed lookup never blocks saving: the address is kept without
 * coordinates and the travel-time check is simply skipped for it.
 */
import { log } from "@/lib/log";
import type { Place } from "@/lib/travel";

export interface Geocoder {
  lookup(query: string): Promise<Place | null>;
}

const PDOK = "https://api.pdok.nl/bzk/locatieserver/search/v3_1/free";

export class PdokGeocoder implements Geocoder {
  async lookup(query: string): Promise<Place | null> {
    const url = `${PDOK}?${new URLSearchParams({ q: query, rows: "1", fl: "weergavenaam,centroide_ll", fq: "type:(adres OR postcode OR weg OR woonplaats)" })}`;
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(4000), headers: { accept: "application/json" } });
      if (!res.ok) return null;
      const body = (await res.json()) as { response?: { docs?: Array<{ weergavenaam?: string; centroide_ll?: string }> } };
      const doc = body.response?.docs?.[0];
      const m = doc?.centroide_ll && /POINT\(([-\d.]+) ([-\d.]+)\)/.exec(doc.centroide_ll);
      if (!doc || !m) return null;
      return { address: doc.weergavenaam ?? query, lng: Number(m[1]), lat: Number(m[2]) };
    } catch (err) {
      log.warn("geo.lookup_failed", { err: (err as Error).message });
      return null;
    }
  }
}

let override: Geocoder | null = null;
const offline: Geocoder = { lookup: async () => null };

export function setGeocoder(g: Geocoder | null) {
  override = g;
}

export function geocoder(): Geocoder {
  if (override) return override;
  // Tests and offline demos never call out.
  if (process.env.NODE_ENV === "test" || process.env.GEOCODER === "off") return offline;
  return new PdokGeocoder();
}
