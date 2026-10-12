import { NextResponse } from "next/server";
import { z } from "zod";
import { withTenant } from "@/lib/db";
import { allow } from "@/lib/rate-limit";
import { jsonRoute } from "@/server/api";
import { requireSchoolActor } from "@/server/auth/session";
import { userPrincipal } from "@/server/principal";
import { exportStudentData } from "@/server/services/privacy";

export const dynamic = "force-dynamic";

/** GET /api/students/:id/export — everything held about a student (GDPR access / portability), as a JSON download. */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  let file: { json: string; number: string } | null = null;
  const errorResponse = await jsonRoute(async () => {
    const { id } = z.object({ id: z.string().uuid() }).parse(await params);
    const actor = await requireSchoolActor();
    if (!(await allow(`export:${actor.userId}`, 10, 3600_000))) return { rateLimited: true };
    const data = await withTenant(actor.schoolId, (tx) => exportStudentData(tx, userPrincipal(actor), id));
    file = { json: JSON.stringify(data, null, 2), number: String(data.student.student_number) };
    return {};
  });
  if (!file) {
    return errorResponse.status === 200 ? NextResponse.json({ error: { code: "rate_limited", message: "Too many exports, try again later." } }, { status: 429 }) : errorResponse;
  }
  const { json, number } = file as { json: string; number: string };
  return new NextResponse(json, {
    headers: {
      "content-type": "application/json; charset=utf-8",
      "content-disposition": `attachment; filename="data-${number.replace(/[^A-Za-z0-9-]/g, "")}.json"`,
      "cache-control": "no-store",
    },
  });
}
