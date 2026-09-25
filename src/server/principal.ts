import type { SchoolActor } from "@/lib/rbac";

/**
 * Who is performing a service call. Services use it for authorisation,
 * ownership checks and the audit log.
 */
export type Principal =
  | { type: "user"; schoolId: string; actor: SchoolActor }
  | { type: "ai_agent"; schoolId: string; studentId: string | null; conversationId: string }
  | { type: "system"; schoolId: string }
  | { type: "webhook"; schoolId: string; source: string };

export const userPrincipal = (actor: SchoolActor): Principal => ({ type: "user", schoolId: actor.schoolId, actor });

export function actorUserId(p: Principal): string | null {
  return p.type === "user" ? p.actor.userId : null;
}
