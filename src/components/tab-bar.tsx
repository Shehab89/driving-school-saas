"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";

const ICONS: Record<string, string> = {
  home: "M3 11 12 4l9 7v9a1 1 0 0 1-1 1h-5v-6h-6v6H4a1 1 0 0 1-1-1z",
  lessons: "M4 5h16v14H4zM4 9h16M9 5v14",
  book: "M5 4h14v16H5zM5 9h14M9 2v4M15 2v4M9 14h6M12 11v6",
  payments: "M3 6h18v12H3zM3 10h18M7 15h4",
  profile: "M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4 21a8 8 0 0 1 16 0",
  today: "M12 7v5l3 2M12 21a9 9 0 1 1 0-18 9 9 0 0 1 0 18z",
  calendar: "M4 5h16v15H4zM4 9h16M8 3v4M16 3v4",
  students: "M9 11a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7zM2 20a7 7 0 0 1 14 0M16 4.5a3.5 3.5 0 0 1 0 6.5M18 13.5a6 6 0 0 1 4 6.5",
  availability: "M4 5h16v15H4zM4 9h16M8 13h3M8 16h3M14 13h2",
};

function Icon({ name }: { name: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={ICONS[name]} />
    </svg>
  );
}


export function TabBar({ label, tabs }: { label: string; tabs: Array<{ key: string; href: string; label: string }> }) {
  const path = usePathname();
  // The first tab is the app's home: exact match. Others also match their sub-pages.
  const active = tabs.find((t, i) => (i === 0 ? path === t.href : path === t.href || path.startsWith(t.href + "/")))?.key;
  return (
    <nav className="tabbar" aria-label={label}>
      {tabs.map((tab) => (
        <Link key={tab.key} href={tab.href} aria-current={active === tab.key ? "page" : undefined}>
          <Icon name={tab.key} />
          {tab.label}
        </Link>
      ))}
    </nav>
  );
}
