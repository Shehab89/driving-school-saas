import { NextResponse } from "next/server";
import { hasCronSecret } from "@/lib/cron-auth";
import { runJobsTick } from "@/server/jobs/scheduler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Call every minute: `Authorization: Bearer $CRON_SECRET`. */
export async function GET(req: Request) {
  if (!hasCronSecret(req)) return new Response("unauthorized", { status: 401 });
  const result = await runJobsTick();
  return NextResponse.json(result, { status: result.ok ? 200 : 500 });
}
export const POST = GET;
