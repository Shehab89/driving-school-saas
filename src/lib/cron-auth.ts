import { timingSafeEqual } from "node:crypto";
import { env } from "./env";

/** Constant-time check of `Authorization: Bearer $CRON_SECRET` for machine endpoints. */
export function hasCronSecret(req: Request): boolean {
  const given = Buffer.from(req.headers.get("authorization")?.replace(/^Bearer /, "") ?? "");
  const expected = Buffer.from(env.cronSecret);
  return given.length === expected.length && timingSafeEqual(given, expected);
}
