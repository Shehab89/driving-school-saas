import "server-only";
import { cache } from "react";
import { one, withTenant } from "@/lib/db";
import { getI18n } from "@/i18n/server";
import { portalTranslator } from "@/i18n/portal";
import { logoUrl } from "@/server/services/branding";
import type { SchoolBrandView } from "@/components/school-brand";

/** Read once per request (layout, page and components all need it). */
export const schoolHeader = cache(async (schoolId: string) =>
  withTenant(schoolId, async (tx) =>
    (await one<{ name: string; timezone: string; currency: string; locale: string; brand_color: string | null; logo_at: Date | null }>(
      tx,
      `SELECT s.name, s.timezone, s.currency, s.locale, s.brand_color, l.updated_at AS logo_at
         FROM schools s LEFT JOIN school_logos l ON l.school_id = s.id WHERE s.id = $1`,
      [schoolId],
    ))!,
  ),
);

/** Colour and logo for the app frames. */
export async function schoolBrand(schoolId: string): Promise<SchoolBrandView> {
  const s = await schoolHeader(schoolId);
  return { color: s.brand_color, logo: logoUrl(schoolId, s.logo_at) };
}

/** School header + translator + formatters in the school's timezone. */
export async function schoolI18n(schoolId: string) {
  const school = await schoolHeader(schoolId);
  const i18n = await getI18n(school.timezone);
  // pt: school-portal texts (English text as key, see i18n/portal.ts).
  return { school, ...i18n, pt: portalTranslator(i18n.locale) };
}
