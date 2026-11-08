import "server-only";
import { homePathFor, type Role } from "@/lib/rbac";
import { soloModeFor } from "../services/solo";

/** Where a signed-in user lands. One-person schools go straight to the single "My school" app. */
export async function homePathForActor(actor: { role: Role; schoolId: string | null; instructorId: string | null }): Promise<string> {
  if (await soloModeFor(actor)) return "/instructor";
  return homePathFor(actor.role);
}
