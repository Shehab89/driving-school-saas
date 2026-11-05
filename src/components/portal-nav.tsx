"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";

const ICONS: Record<string, string> = {
  dashboard: "M4 13h6V4H4zM14 20h6v-9h-6zM4 20h6v-3H4zM14 7h6V4h-6z",
  calendar: "M4 5h16v15H4zM4 9h16M8 3v4M16 3v4",
  students: "M9 11a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7zM2 20a7 7 0 0 1 14 0M16 4.5a3.5 3.5 0 0 1 0 6.5M18 13.5a6 6 0 0 1 4 6.5",
  instructors: "M12 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4 21a8 8 0 0 1 16 0M9 16l3 2 3-2",
  vehicles: "M5 16V11l2-5h10l2 5v5M3 16h18v3H3zM7.5 19v1.5M16.5 19v1.5M5 11h14",
  payments: "M3 6h18v12H3zM3 10h18M7 15h4",
  billing: "M6 3h12v18l-3-2-3 2-3-2-3 2zM9 8h6M9 12h6",
  reports: "M4 20V10M10 20V4M16 20v-7M22 20H2",
  whatsapp: "M4 20l1.5-4A8 8 0 1 1 8 18.5zM9 10h6M9 13h4",
  messages: "M3 6h18v12H3zM3 7l9 6 9-6",
  team: "M8 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM16 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM2 20a6 6 0 0 1 12 0M12 20a6 6 0 0 1 10 0",
  settings: "M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z",
  support: "M12 21a9 9 0 1 1 0-18 9 9 0 0 1 0 18zM9.5 9a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .9-1 1.6V14M12 17h.01",
  account: "M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4 21a8 8 0 0 1 16 0",
  mycalendar: "M12 7v5l3 2M12 21a9 9 0 1 1 0-18 9 9 0 0 1 0 18z",
  schools: "M3 21h18M5 21V8l7-5 7 5v13M9 21v-6h6v6",
  audit: "M9 5h11M9 12h11M9 19h11M4 5h.01M4 12h.01M4 19h.01",
  more: "M5 12h.01M12 12h.01M19 12h.01",
  plus: "M12 5v14M5 12h14",
};

export function PortalIcon({ name }: { name: string }) {
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={ICONS[name] ?? ICONS.more} />
    </svg>
  );
}

export interface NavItem {
  href: string;
  label: string;
  icon: string;
}

/** Longest matching prefix wins, so /admin is only active on the dashboard itself. */
function activeHref(path: string, items: NavItem[]) {
  let best: string | null = null;
  for (const i of items) {
    const hit = path === i.href || (i.href !== "/admin" && i.href !== "/platform" && path.startsWith(i.href + "/"));
    if (hit && (!best || i.href.length > best.length)) best = i.href;
  }
  // Lesson and student detail pages belong to the calendar and the student list.
  if (!best && path.startsWith("/lessons/")) best = "/admin/calendar";
  if (!best && path.startsWith("/students/")) best = "/admin/students";
  return best;
}

export function PortalNav({ groups, label }: { groups: Array<{ title: string; items: NavItem[] }>; label: string }) {
  const path = usePathname();
  const active = activeHref(path, groups.flatMap((g) => g.items));
  return (
    <nav className="side-nav" aria-label={label}>
      {groups.map((g) => (
        <div key={g.title} className="side-group">
          {g.title && <div className="side-group-title">{g.title}</div>}
          {g.items.map((i) => (
            <Link key={i.href} href={i.href} aria-current={active === i.href ? "page" : undefined}>
              <PortalIcon name={i.icon} />
              <span>{i.label}</span>
            </Link>
          ))}
        </div>
      ))}
    </nav>
  );
}

/** Phone: four most-used screens + "More" (opens the full menu). */
export function PortalTabs({ items, moreLabel, label }: { items: NavItem[]; moreLabel: string; label: string }) {
  const path = usePathname();
  const active = activeHref(path, items);
  return (
    <nav className="portal-tabs" aria-label={label}>
      {items.map((i) => (
        <Link key={i.href} href={i.href} aria-current={active === i.href ? "page" : undefined}>
          <PortalIcon name={i.icon} />
          <span>{i.label}</span>
        </Link>
      ))}
      <button type="button" popoverTarget="portal-menu">
        <PortalIcon name="more" />
        <span>{moreLabel}</span>
      </button>
    </nav>
  );
}
