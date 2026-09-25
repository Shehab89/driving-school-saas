import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { sp, type SearchParams } from "@/components/ui";
import { getI18n } from "@/i18n/server";
import { getActor } from "@/server/auth/session";
import { LoginForm } from "../form";

export async function generateMetadata({ params }: { params: Promise<{ app: string }> }): Promise<Metadata> {
  const { app } = await params;
  return app === "student" || app === "instructor"
    ? { title: app === "student" ? "DriveDesk Student" : "DriveDesk Instructor", manifest: `/${app}.webmanifest` }
    : {};
}

/** Sign-in for the student app (/login/student) or the instructor app (/login/instructor). */
export default async function AppLoginPage({ params, searchParams }: { params: Promise<{ app: string }>; searchParams: SearchParams }) {
  const { app } = await params;
  if (app !== "student" && app !== "instructor") notFound();
  const q = await sp(searchParams);
  const actor = await getActor();
  if (actor && !q.wrong) {
    if (app === "student" && actor.role === "student") redirect("/student");
    if (app === "instructor" && ["instructor", "school_owner", "school_admin"].includes(actor.role)) redirect("/instructor");
  }
  const { t, locale } = await getI18n();
  const params2 = q.wrong ? { ...q, error: t("apps.wrongApp", { app: t(app === "student" ? "apps.student" : "apps.instructor") }) } : q;
  return <LoginForm app={app} t={t} locale={locale} params={params2} />;
}
