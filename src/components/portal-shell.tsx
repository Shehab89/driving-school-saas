import Link from "next/link";
import { can, type Role } from "@/lib/rbac";
import { getI18n } from "@/i18n/server";
import { portalTranslator, type PortalTranslate } from "@/i18n/portal";
import { BrandStyle, SchoolMark, type SchoolBrandView } from "./school-brand";
import { LanguageSwitcher } from "./language-switcher";
import { PortalIcon, PortalNav, PortalTabs, type NavItem } from "./portal-nav";
import { CommandButton, CommandPalette, type Command } from "./command-palette";

type Group = { title: string; items: NavItem[] };

function navFor(role: Role, pt: PortalTranslate, extra: NavItem[]): Group[] {
  if (role === "saas_admin") {
    return [{ title: "", items: [
      { href: "/platform", label: pt("Schools"), icon: "schools" },
      { href: "/platform/audit", label: pt("Audit log"), icon: "audit" },
      { href: "/account", label: pt("Account"), icon: "account" },
    ] }];
  }
  const owner = role === "school_owner";
  const groups: Group[] = [
    { title: pt("Daily work"), items: [
      { href: "/admin", label: pt("Dashboard"), icon: "dashboard" },
      { href: "/admin/calendar", label: pt("Calendar"), icon: "calendar" },
      { href: "/admin/students", label: pt("Students"), icon: "students" },
      { href: "/admin/payments", label: pt("Payments"), icon: "payments" },
      { href: "/admin/exams", label: pt("CBR exams"), icon: "exams" },
      { href: "/admin/whatsapp", label: pt("WhatsApp"), icon: "whatsapp" },
      { href: "/admin/messages", label: pt("Message students"), icon: "messages" },
      ...extra,
    ] },
    { title: pt("Team & cars"), items: [
      { href: "/admin/instructors", label: pt("Instructors"), icon: "instructors" },
      { href: "/admin/vehicles", label: pt("Cars"), icon: "vehicles" },
      ...(owner ? [{ href: "/admin/team", label: pt("Team"), icon: "team" }] : []),
    ] },
    { title: pt("Business"), items: [
      { href: "/admin/reports", label: pt("Reports"), icon: "reports" },
      { href: "/admin/notifications", label: pt("Sent messages"), icon: "messages" },
      ...(owner ? [{ href: "/admin/billing", label: pt("Payment settings"), icon: "billing" }] : []),
    ] },
    { title: pt("School"), items: [
      ...(owner ? [{ href: "/admin/settings", label: pt("Settings"), icon: "settings" }, { href: "/admin/support", label: pt("Support access"), icon: "support" }] : []),
      { href: "/account", label: pt("My account"), icon: "account" },
    ] },
  ];
  return groups.filter((g) => g.items.length);
}

/**
 * School portal frame. Wide screens: a sidebar with grouped navigation and a
 * prominent "New lesson" button. Phones: a compact top bar, a bottom bar with
 * the four most-used screens, and "More" for the rest. Follows the user's
 * language (English, Dutch, Arabic right-to-left).
 */
export async function Shell({ role, title, children, extraNav = [], solo = false, brand }: { role: Role; title: string; children: React.ReactNode; extraNav?: Array<[string, string]>; solo?: boolean; brand?: SchoolBrandView }) {
  const { locale, t } = await getI18n();
  const pt = portalTranslator(locale);
  const extra = extraNav.map(([href, label]) => ({ href, label: pt(label), icon: "mycalendar" }));
  const groups = navFor(role, pt, extra);
  const canBook = can(role, "lessons:write_all");
  const subtitle = role === "saas_admin" ? pt("Platform admin") : solo ? t("apps.mySchool") : pt("School portal");
  // A one-person school keeps the bottom bar of its phone app ("My school") on these screens too.
  const tabs: NavItem[] = solo
    ? [
        { href: "/instructor", label: t("instructor.tabs.today"), icon: "mycalendar" },
        { href: "/instructor/students", label: t("instructor.tabs.students"), icon: "students" },
        { href: "/instructor/money", label: t("instructor.tabs.money"), icon: "payments" },
      ]
    : role === "saas_admin" ? groups[0]!.items.slice(0, 2) : groups[0]!.items.slice(0, 4);
  const home = solo ? "/instructor" : "/";
  const isSchool = role !== "saas_admin";
  const commands: Command[] = [
    ...(canBook ? [{ href: "/admin/lessons/new", label: pt("New lesson"), group: pt("Actions"), icon: "plus" }] : []),
    ...(isSchool && can(role, "students:write") ? [{ href: "/admin/students?new=1", label: pt("Add student"), group: pt("Actions"), icon: "students" }] : []),
    ...groups.flatMap((g) => g.items.map((i) => ({ href: i.href, label: i.label, group: pt("Go to"), icon: i.icon }))),
  ];
  const search = pt("Search or jump to…");
  const footer = (
    <div className="side-foot">
      <LanguageSwitcher current={locale} label={t("common.language")} />
      <form action="/logout" method="post">
        <button type="submit" className="ghost sm">{pt("Log out")}</button>
      </form>
    </div>
  );
  const newLesson = canBook && (
    <Link className="btn accent block side-cta" href="/admin/lessons/new">
      <PortalIcon name="plus" /> {pt("New lesson")}
    </Link>
  );

  return (
    <div className="portal">
      <BrandStyle color={brand?.color} />
      <aside className="side">
        <Link href={home} className="side-brand">
          <SchoolMark brand={brand} size={34} name={title} />
          <span><strong>{title}</strong><small>{subtitle}</small></span>
        </Link>
        {newLesson}
        <CommandButton label={search} />
        <PortalNav groups={groups} label={pt("Main menu")} />
        {footer}
      </aside>

      <header className="portal-top">
        <Link href={home} className="side-brand">
          <SchoolMark brand={brand} size={30} name={title} />
          <span><strong>{title}</strong><small>{subtitle}</small></span>
        </Link>
        {canBook && (
          <Link className="btn accent sm" href="/admin/lessons/new" aria-label={pt("New lesson")}>
            <PortalIcon name="plus" />
          </Link>
        )}
        <CommandButton label={search} compact />
        <button type="button" className="sm" popoverTarget="portal-menu">{pt("Menu")}</button>
      </header>

      <div id="portal-menu" popover="auto" className="portal-sheet">
        <div className="spread" style={{ marginBottom: 8 }}>
          <strong>{pt("Menu")}</strong>
          <button type="button" className="ghost sm" popoverTarget="portal-menu" popoverTargetAction="hide">{t("common.close")}</button>
        </div>
        {newLesson}
        <PortalNav groups={groups} label={pt("Main menu")} />
        {footer}
      </div>

      <main className="portal-main">{children}</main>
      <CommandPalette
        commands={commands}
        labels={{
          open: search,
          placeholder: pt("Type a page, a task or a student's name"),
          empty: pt("Nothing found"),
          searchStudents: pt("Search students for “{query}”"),
          studentsGroup: pt("Students"),
          hint: pt("Tip: press Ctrl K (⌘ K on Mac) or / to open this anywhere."),
        }}
      />
      <PortalTabs items={tabs} moreLabel={solo ? t("instructor.tabs.more") : pt("More")} moreHref={solo ? "/instructor/more" : undefined} label={pt("Quick menu")} />
    </div>
  );
}
