import "server-only";
import { redirect } from "next/navigation";
import { requireSchoolPage } from "@/server/auth/session";
import { schoolI18n } from "@/server/school";

/** Signed-in instructor (owners/admins who teach have an instructor profile too). */
export async function loadInstructor() {
  const actor = await requireSchoolPage("lessons:operate_own");
  const i18n = await schoolI18n(actor.schoolId);
  return { actor, ...i18n };
}

export async function requireInstructorProfile() {
  const ctx = await loadInstructor();
  if (!ctx.actor.instructorId) redirect("/instructor");
  return ctx as typeof ctx & { actor: typeof ctx.actor & { instructorId: string } };
}
