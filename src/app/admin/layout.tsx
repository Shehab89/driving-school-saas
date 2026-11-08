import { Shell } from "@/components/ui";
import { requireSchoolPage } from "@/server/auth/session";
import { schoolHeader } from "@/server/school";
import { soloModeFor } from "@/server/services/solo";

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const actor = await requireSchoolPage("students:read_all");
  const school = await schoolHeader(actor.schoolId);
  const solo = await soloModeFor(actor);
  return (
    <Shell role={actor.role} title={school.name} solo={solo} extraNav={actor.instructorId ? [["/instructor", "My calendar"]] : []}>
      {children}
    </Shell>
  );
}
