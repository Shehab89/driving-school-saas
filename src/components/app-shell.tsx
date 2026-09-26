import Link from "next/link";
import type { Translate } from "@/i18n";
import { Mark } from "./brand";
import { TabBar } from "./tab-bar";

export type AppKind = "student" | "instructor";

export const TABS: Record<AppKind, Array<{ key: string; href: string }>> = {
  student: [
    { key: "home", href: "/student" },
    { key: "lessons", href: "/student/lessons" },
    { key: "feedback", href: "/student/feedback" },
    { key: "book", href: "/student/book" },
    { key: "payments", href: "/student/payments" },
  ],
  instructor: [
    { key: "today", href: "/instructor" },
    { key: "calendar", href: "/instructor/calendar" },
    { key: "students", href: "/instructor/students" },
    { key: "feedback", href: "/instructor/feedback" },
    { key: "availability", href: "/instructor/availability" },
  ],
};

/** Phone-first shell: top bar (brand, school, profile), bottom tab bar (top tabs on wide screens). */
export function AppShell({
  app,
  schoolName,
  userInitial,
  badges = {},
  t,
  children,
}: {
  app: AppKind;
  schoolName: string;
  userInitial: string;
  /** Tabs that should show a "new" dot. */
  badges?: Record<string, boolean>;
  t: Translate;
  children: React.ReactNode;
}) {
  const appLabel = t(app === "student" ? "apps.student" : "apps.instructor");
  return (
    <>
      <header className="app-top">
        <Mark variant={app} size={36} />
        <div className="who">
          <strong>{schoolName}</strong>
          <span>{appLabel}</span>
        </div>
        <Link className="avatar-btn" href={`/${app}/profile`} aria-label={t("common.profile")}>
          {userInitial}
        </Link>
      </header>
      <TabBar
        label={appLabel}
        tabs={TABS[app].map((tab) => ({ ...tab, label: t(`${app}.tabs.${tab.key}` as Parameters<Translate>[0]), dot: Boolean(badges[tab.key]) }))}
      />
      <main className="app-main">{children}</main>
    </>
  );
}
