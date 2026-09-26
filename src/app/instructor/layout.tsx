import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { AppShell } from "@/components/app-shell";
import { getActor } from "@/server/auth/session";
import { schoolI18n } from "@/server/school";
import { instructorBadge } from "./data";

export const metadata: Metadata = { title: "DriveDesk Instructor", manifest: "/instructor.webmanifest", appleWebApp: { title: "DriveDesk Instructor", capable: true } };

export default async function InstructorLayout({ children }: { children: React.ReactNode }) {
  const actor = await getActor();
  if (!actor || !actor.schoolId) redirect("/login/instructor");
  if (!["instructor", "school_owner", "school_admin"].includes(actor.role)) redirect("/login/instructor?wrong=1");
  const { school, t } = await schoolI18n(actor.schoolId);
  const { name, waiting } = await instructorBadge(actor.schoolId, actor.instructorId, actor.email);
  return (
    <AppShell app="instructor" schoolName={school.name} userInitial={name.slice(0, 1).toUpperCase()} badges={{ feedback: waiting > 0 }} t={t}>
      {children}
    </AppShell>
  );
}
