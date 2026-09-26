import Link from "next/link";
import type { Role } from "@/lib/rbac";
import { Mark } from "./brand";

export function Flash({ searchParams }: { searchParams: { error?: string; ok?: string } }) {
  if (searchParams.error) return <div className="flash error" role="alert">{searchParams.error}</div>;
  if (searchParams.ok) return <div className="flash ok" role="status">{searchParams.ok}</div>;
  return null;
}

const NAV: Record<Role, Array<[string, string]>> = {
  saas_admin: [["/platform", "Schools"]],
  school_owner: [
    ["/admin", "Dashboard"],
    ["/admin/calendar", "Calendar"],
    ["/admin/students", "Students"],
    ["/admin/instructors", "Instructors"],
    ["/admin/vehicles", "Vehicles"],
    ["/admin/payments", "Payments"],
    ["/admin/whatsapp", "WhatsApp"],
    ["/admin/settings", "Settings"],
  ],
  school_admin: [
    ["/admin", "Dashboard"],
    ["/admin/calendar", "Calendar"],
    ["/admin/students", "Students"],
    ["/admin/instructors", "Instructors"],
    ["/admin/vehicles", "Vehicles"],
    ["/admin/payments", "Payments"],
    ["/admin/whatsapp", "WhatsApp"],
  ],
  instructor: [
    ["/instructor", "Calendar"],
    ["/instructor/availability", "Availability"],
  ],
  student: [
    ["/student", "Dashboard"],
    ["/student/profile", "Profile"],
  ],
};

export function Shell({ role, title, children, extraNav = [] }: { role: Role; title: string; children: React.ReactNode; extraNav?: Array<[string, string]> }) {
  // The school portal is English-only for now; keep it left-to-right whatever the chosen language.
  return (
    <div dir="ltr" lang="en">
      <header className="topbar">
        <Link href="/" className="brand"><Mark size={30} />{title}</Link>
        <nav aria-label="Main">
          {[...NAV[role], ...extraNav].map(([href, label]) => (
            <Link key={href} href={href}>{label}</Link>
          ))}
          <form action="/logout" method="post" style={{ display: "inline" }}>
            <button type="submit" style={{ minHeight: 32, padding: "4px 10px" }}>Log out</button>
          </form>
        </nav>
      </header>
      <main className="container">{children}</main>
    </div>
  );
}

export const STATUS_TONE: Record<string, string> = {
  scheduled: "info",
  confirmed: "info",
  in_progress: "warning",
  completed: "success",
  cancelled: "danger",
  no_show: "danger",
  rescheduled: "",
  paid: "success",
  pending: "warning",
  overdue: "danger",
  refunded: "",
  not_required: "",
  failed: "danger",
  suggested: "warning",
  confirmed_level: "success",
  lead: "warning",
  active: "success",
  open: "info",
  handoff: "warning",
  closed: "",
};

export function Badge({ value, label }: { value: string; label?: string }) {
  return <span className={`badge ${STATUS_TONE[value] ?? ""}`}>{label ?? value.replace(/_/g, " ")}</span>;
}

export function ProgressBar({ value, label }: { value: number; label: string }) {
  const pct = Math.max(0, Math.min(100, Math.round(value * 100)));
  return (
    <div className="progress" role="progressbar" aria-label={label} aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
      <span style={{ width: `${pct}%` }} />
    </div>
  );
}

export type SearchParams = Promise<Record<string, string | string[] | undefined>>;
export async function sp(p: SearchParams): Promise<Record<string, string>> {
  const raw = await p;
  return Object.fromEntries(Object.entries(raw).map(([k, v]) => [k, Array.isArray(v) ? (v[0] ?? "") : (v ?? "")]));
}

/** Status pill with a translated label. */
export function StatusBadge({ value, t }: { value: string; t: (key: never) => string }) {
  const tr = t as unknown as (k: string) => string;
  const label = tr(`status.${value}`);
  return <Badge value={value} label={label.startsWith("status.") ? value.replace(/_/g, " ") : label} />;
}
