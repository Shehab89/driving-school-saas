import { AppShell } from "@/components/app-shell";
import { Shell } from "@/components/ui";
import { requireSchoolPage } from "@/server/auth/session";
import { schoolI18n } from "@/server/school";
import { instructorBadge } from "../instructor/data";

/** Lesson detail and student profile: shown inside the instructor app for instructors, inside the school portal for staff. */
export default async function StaffLayout({ children }: { children: React.ReactNode }) {
  const actor = await requireSchoolPage("lessons:operate_own");
  const { school, t } = await schoolI18n(actor.schoolId);
  if (actor.role === "instructor") {
    const { name, waiting } = await instructorBadge(actor.schoolId, actor.instructorId, actor.email);
    return (
      <AppShell app="instructor" schoolName={school.name} userInitial={name.slice(0, 1).toUpperCase()} badges={{ feedback: waiting > 0 }} t={t}>
        {children}
      </AppShell>
    );
  }
  return <Shell role={actor.role} title={school.name}>{children}</Shell>;
}
