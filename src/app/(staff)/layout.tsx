import { AppShell } from "@/components/app-shell";
import { Shell } from "@/components/ui";
import { requireSchoolPage } from "@/server/auth/session";
import { schoolI18n } from "@/server/school";

/** Lesson detail and student profile: shown inside the instructor app for instructors, inside the school portal for staff. */
export default async function StaffLayout({ children }: { children: React.ReactNode }) {
  const actor = await requireSchoolPage("lessons:operate_own");
  const { school, t, locale } = await schoolI18n(actor.schoolId);
  if (actor.role === "instructor") {
    return <AppShell app="instructor" schoolName={school.name} t={t} locale={locale}>{children}</AppShell>;
  }
  return <Shell role={actor.role} title={school.name}>{children}</Shell>;
}
