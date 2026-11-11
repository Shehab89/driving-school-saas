import Link from "next/link";
import type { Translate } from "@/i18n";
import { BrandStyle, SchoolMark, type SchoolBrandView } from "./school-brand";
import { TabBar } from "./tab-bar";

export type AppKind = "student" | "instructor";

export const TABS: Record<AppKind | "solo", Array<{ key: string; href: string }>> = {
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
  // One-person school: the owner's single app ("My school").
  solo: [
    { key: "today", href: "/instructor" },
    { key: "students", href: "/instructor/students" },
    { key: "money", href: "/instructor/money" },
    { key: "more", href: "/instructor/more" },
  ],
};

/** Phone-first shell: top bar (brand, school, profile), bottom tab bar (top tabs on wide screens). */
export function AppShell({
  app,
  schoolName,
  userInitial,
  badges = {},
  solo = false,
  brand,
  t,
  children,
}: {
  /** The school's own colour and logo. */
  brand?: SchoolBrandView;
  app: AppKind;
  /** Owner of a one-person school: one app with Today / Students / Money / More. */
  solo?: boolean;
  schoolName: string;
  userInitial: string;
  /** Tabs that should show a "new" dot. */
  badges?: Record<string, boolean>;
  t: Translate;
  children: React.ReactNode;
}) {
  const appLabel = t(solo ? "apps.mySchool" : app === "student" ? "apps.student" : "apps.instructor");
  const tabs = solo ? TABS.solo : TABS[app];
  return (
    <>
      <BrandStyle color={brand?.color} />
      <header className="app-top">
        <SchoolMark brand={brand} variant={app} size={36} name={schoolName} />
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
        tabs={tabs.map((tab) => ({ ...tab, label: t(`${app}.tabs.${tab.key}` as Parameters<Translate>[0]), dot: Boolean(badges[tab.key]) }))}
      />
      <main className="app-main">{children}</main>
    </>
  );
}
