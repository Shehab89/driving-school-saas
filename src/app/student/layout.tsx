import type { Metadata } from "next";
import { AppShell } from "@/components/app-shell";
import { getActor } from "@/server/auth/session";
import { schoolI18n } from "@/server/school";
import { one, withTenant } from "@/lib/db";
import { unseenFeedbackCount } from "@/server/services/feedback";
import { redirect } from "next/navigation";

export const metadata: Metadata = { title: "DriveDesk Student", manifest: "/student.webmanifest", appleWebApp: { title: "DriveDesk Student", capable: true } };

export default async function StudentLayout({ children }: { children: React.ReactNode }) {
  const actor = await getActor();
  if (!actor || !actor.schoolId) redirect("/login/student");
  if (actor.role !== "student" || !actor.studentId) redirect("/login/student?wrong=1");
  const { school, t } = await schoolI18n(actor.schoolId);
  const { name, unseen } = await withTenant(actor.schoolId, async (tx) => ({
    name: (await one<{ first_name: string }>(tx, `SELECT first_name FROM students WHERE id = $1`, [actor.studentId]))?.first_name ?? "",
    unseen: await unseenFeedbackCount(tx, actor.studentId!),
  }));
  return (
    <AppShell app="student" schoolName={school.name} userInitial={name.slice(0, 1).toUpperCase()} badges={{ feedback: unseen > 0 }} t={t}>
      {children}
    </AppShell>
  );
}
