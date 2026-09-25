import { Shell } from "@/components/ui";
import { requireSchoolPage } from "@/server/auth/session";
import { schoolHeader } from "@/server/school";

export default async function InstructorLayout({ children }: { children: React.ReactNode }) {
  const actor = await requireSchoolPage("lessons:operate_own");
  const school = await schoolHeader(actor.schoolId);
  return <Shell role={actor.role} title={school.name}>{children}</Shell>;
}
