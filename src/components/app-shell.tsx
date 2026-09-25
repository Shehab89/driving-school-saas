import type { Locale, Translate } from "@/i18n";
import { LanguageSwitcher } from "./language-switcher";
import { TabBar } from "./tab-bar";

export type AppKind = "student" | "instructor";

export const TABS: Record<AppKind, Array<{ key: string; href: string }>> = {
  student: [
    { key: "home", href: "/student" },
    { key: "lessons", href: "/student/lessons" },
    { key: "book", href: "/student/book" },
    { key: "payments", href: "/student/payments" },
    { key: "profile", href: "/student/profile" },
  ],
  instructor: [
    { key: "today", href: "/instructor" },
    { key: "calendar", href: "/instructor/calendar" },
    { key: "students", href: "/instructor/students" },
    { key: "availability", href: "/instructor/availability" },
    { key: "profile", href: "/instructor/profile" },
  ],
};

/** Phone-first shell: top bar with school + language, bottom tab bar (top tabs on wide screens). */
export function AppShell({
  app,
  schoolName,
  t,
  locale,
  children,
}: {
  app: AppKind;
  schoolName: string;
  t: Translate;
  locale: Locale;
  children: React.ReactNode;
}) {
  return (
    <>
      <header className="app-top">
        <span className={`app-badge ${app}`} aria-hidden="true">{app === "student" ? "L" : "I"}</span>
        <div className="who">
          <strong>{schoolName}</strong>
          <span>{t(app === "student" ? "apps.student" : "apps.instructor")}</span>
        </div>
        <LanguageSwitcher current={locale} label={t("common.language")} />
      </header>
      <TabBar
        label={t(app === "student" ? "apps.student" : "apps.instructor")}
        tabs={TABS[app].map((tab) => ({ ...tab, label: t(`${app}.tabs.${tab.key}` as Parameters<Translate>[0]) }))}
      />
      <main className="app-main">{children}</main>
    </>
  );
}
