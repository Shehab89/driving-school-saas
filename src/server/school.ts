import "server-only";
import { cache } from "react";
import { one, withTenant } from "@/lib/db";
import { getI18n } from "@/i18n/server";

/** Read once per request (layout, page and components all need it). */
export const schoolHeader = cache(async (schoolId: string) =>
  withTenant(schoolId, async (tx) =>
    (await one<{ name: string; timezone: string; currency: string; locale: string }>(tx, `SELECT name, timezone, currency, locale FROM schools WHERE id = $1`, [schoolId]))!,
  ),
);

/** School header + translator + formatters in the school's timezone. */
export async function schoolI18n(schoolId: string) {
  const school = await schoolHeader(schoolId);
  return { school, ...(await getI18n(school.timezone)) };
}
