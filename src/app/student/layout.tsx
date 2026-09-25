import { Shell } from "@/components/ui";
import { requireSchoolPage } from "@/server/auth/session";
import { schoolHeader } from "@/server/school";

export default async function StudentLayout({ children }: { children: React.ReactNode }) {
  const actor = await requireSchoolPage("lessons:request_reschedule");
  const school = await schoolHeader(actor.schoolId);
  return <Shell role={actor.role} title={school.name}>{children}</Shell>;
}
