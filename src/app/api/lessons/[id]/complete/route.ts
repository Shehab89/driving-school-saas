import { z } from "zod";
import { withTenant } from "@/lib/db";
import { jsonRoute } from "@/server/api";
import { requireSchoolActor } from "@/server/auth/session";
import { userPrincipal } from "@/server/principal";
import { completeLesson } from "@/server/services/lessons";

const body = z.object({
  feedback: z
    .object({
      strengths: z.string().max(2000).optional(),
      weaknesses: z.string().max(2000).optional(),
      practiceItems: z.string().max(2000).optional(),
      nextFocus: z.string().max(500).optional(),
      instructorNotes: z.string().max(4000).optional(),
      overallRating: z.number().int().min(1).max(5).optional(),
      overallLevelId: z.string().uuid().nullable().optional(),
      visibleToStudent: z.boolean().optional(),
    })
    .optional(),
  skills: z.array(z.object({ skillId: z.string().uuid(), status: z.enum(["not_started", "in_progress", "needs_improvement", "completed"]) })).max(100).optional(),
  newLevelId: z.string().uuid().nullable().optional(),
  paymentRequired: z.boolean().optional(),
});

/** POST /api/lessons/:id/complete — instructor app endpoint. */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  return jsonRoute(async () => {
    const { id } = z.object({ id: z.string().uuid() }).parse(await params);
    const input = body.parse(await req.json());
    const actor = await requireSchoolActor("lessons:operate_own");
    return withTenant(actor.schoolId, (tx) => completeLesson(tx, userPrincipal(actor), id, input));
  });
}
