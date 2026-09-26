import "server-only";
import { redirect } from "next/navigation";
import { requireSchoolPage } from "@/server/auth/session";
import { schoolI18n } from "@/server/school";
import { one, withTenant } from "@/lib/db";
import { waitingFeedbackCount } from "@/server/services/feedback";

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

/** Name for the avatar and whether the Feedback tab shows a dot. */
export async function instructorBadge(schoolId: string, instructorId: string | null, email: string) {
  if (!instructorId) return { name: email, waiting: 0 };
  return withTenant(schoolId, async (tx) => ({
    name: (await one<{ first_name: string }>(tx, `SELECT first_name FROM instructors WHERE id = $1`, [instructorId]))?.first_name ?? email,
    waiting: await waitingFeedbackCount(tx, instructorId),
  }));
}
