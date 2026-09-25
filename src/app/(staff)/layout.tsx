import { Shell } from "@/components/ui";
import { requireSchoolPage } from "@/server/auth/session";
import { schoolHeader } from "@/server/school";

/** Pages shared by instructors and school staff (lesson detail, student profile). */
export default async function StaffLayout({ children }: { children: React.ReactNode }) {
  const actor = await requireSchoolPage("lessons:operate_own");
  const school = await schoolHeader(actor.schoolId);
  return <Shell role={actor.role} title={school.name}>{children}</Shell>;
}
