import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { AppShell } from "@/components/app-shell";
import { getActor } from "@/server/auth/session";
import { schoolI18n } from "@/server/school";

export const metadata: Metadata = { title: "DriveDesk Instructor", manifest: "/instructor.webmanifest", appleWebApp: { title: "DriveDesk Instructor", capable: true } };

export default async function InstructorLayout({ children }: { children: React.ReactNode }) {
  const actor = await getActor();
  if (!actor || !actor.schoolId) redirect("/login/instructor");
  if (!["instructor", "school_owner", "school_admin"].includes(actor.role)) redirect("/login/instructor?wrong=1");
  const { school, t, locale } = await schoolI18n(actor.schoolId);
  return (
    <AppShell app="instructor" schoolName={school.name} t={t} locale={locale}>
      {children}
    </AppShell>
  );
}
