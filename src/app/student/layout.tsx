import type { Metadata } from "next";
import { AppShell } from "@/components/app-shell";
import { getActor } from "@/server/auth/session";
import { schoolI18n } from "@/server/school";
import { redirect } from "next/navigation";

export const metadata: Metadata = { title: "DriveDesk Student", manifest: "/student.webmanifest", appleWebApp: { title: "DriveDesk Student", capable: true } };

export default async function StudentLayout({ children }: { children: React.ReactNode }) {
  const actor = await getActor();
  if (!actor || !actor.schoolId) redirect("/login/student");
  if (actor.role !== "student" || !actor.studentId) redirect("/login/student?wrong=1");
  const { school, t, locale } = await schoolI18n(actor.schoolId);
  return (
    <AppShell app="student" schoolName={school.name} t={t} locale={locale}>
      {children}
    </AppShell>
  );
}
