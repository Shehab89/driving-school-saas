import { z } from "zod";
import { withTenant } from "@/lib/db";
import { jsonRoute } from "@/server/api";
import { requireSchoolActor } from "@/server/auth/session";
import { userPrincipal } from "@/server/principal";
import { rescheduleLesson } from "@/server/services/lessons";

const body = z.object({
  slot: z.object({ start: z.coerce.date(), end: z.coerce.date(), instructorId: z.string().uuid(), vehicleId: z.string().uuid().nullable() }),
  reason: z.string().max(300).optional(),
});

/** POST /api/lessons/:id/reschedule — the 24h rule is enforced here, whatever the client did. */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  return jsonRoute(async () => {
    const { id } = z.object({ id: z.string().uuid() }).parse(await params);
    const input = body.parse(await req.json());
    const actor = await requireSchoolActor();
    const channel = actor.role === "student" ? "student_portal" : "staff";
    return withTenant(actor.schoolId, (tx) => rescheduleLesson(tx, userPrincipal(actor), id, input.slot, { channel, reason: input.reason }));
  });
}
