import "server-only";
import { withTenant } from "@/lib/db";
import { requireSchoolPage } from "@/server/auth/session";
import { schoolI18n } from "@/server/school";
import { getStudentDashboard } from "@/server/services/students";

/** Everything the student app pages need for the signed-in student. */
export async function loadStudent() {
  const actor = await requireSchoolPage("lessons:request_reschedule");
  const i18n = await schoolI18n(actor.schoolId);
  const d = await withTenant(actor.schoolId, (tx) => getStudentDashboard(tx, actor.schoolId, actor.studentId!, i18n.locale));
  return { actor, ...i18n, d };
}
