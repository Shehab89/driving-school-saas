import "server-only";
import { one, withTenant } from "@/lib/db";

export async function schoolHeader(schoolId: string) {
  return withTenant(schoolId, async (tx) =>
    (await one<{ name: string; timezone: string; currency: string; locale: string }>(tx, `SELECT name, timezone, currency, locale FROM schools WHERE id = $1`, [schoolId]))!,
  );
}
