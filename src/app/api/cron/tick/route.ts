import { NextResponse } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { env } from "@/lib/env";
import { runAllJobs } from "@/server/jobs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function authorized(req: Request) {
  const given = Buffer.from(req.headers.get("authorization")?.replace(/^Bearer /, "") ?? "");
  const expected = Buffer.from(env.cronSecret);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

/** Call every minute: `Authorization: Bearer $CRON_SECRET`. */
export async function GET(req: Request) {
  if (!authorized(req)) return new Response("unauthorized", { status: 401 });
  return NextResponse.json(await runAllJobs());
}
export const POST = GET;
