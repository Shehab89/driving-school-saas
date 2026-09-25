import { Shell } from "@/components/ui";
import { requireSchoolPage } from "@/server/auth/session";
import { schoolHeader } from "@/server/school";

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const actor = await requireSchoolPage("students:read_all");
  const school = await schoolHeader(actor.schoolId);
  return (
    <Shell role={actor.role} title={school.name} extraNav={actor.instructorId ? [["/instructor", "My calendar"]] : []}>
      {children}
    </Shell>
  );
}
