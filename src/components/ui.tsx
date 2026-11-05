import Link from "next/link";
import type { Role } from "@/lib/rbac";
import { Mark } from "./brand";
import { isValidFlash } from "@/lib/flash";
import { interpolate } from "@/i18n";
import type { PortalTranslate } from "@/i18n/portal";

/** Banner for ?ok= / ?error= — shown only when the app signed it (see lib/flash). */
export function Flash({ searchParams }: { searchParams: { error?: string; ok?: string; fs?: string } }) {
  const { error, ok, fs } = searchParams;
  if (error && isValidFlash("error", error, fs)) return <div className="flash error" role="alert">{error}</div>;
  if (ok && isValidFlash("ok", ok, fs)) return <div className="flash ok" role="status">{ok}</div>;
  return null;
}

export { Shell } from "./portal-shell";

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

/** Previous / next links for a paged list. `hasNext` comes from fetching one row more than the page size. */
export function Pager({ page, hasNext, href, pt = (s, p) => interpolate(s, p) }: { page: number; hasNext: boolean; href: (page: number) => string; pt?: PortalTranslate }) {
  if (page <= 1 && !hasNext) return null;
  return (
    <nav className="row" aria-label={pt("Pages")} style={{ justifyContent: "space-between", marginTop: 8 }}>
      {page > 1 ? <a className="btn sm" href={href(page - 1)}><span className="flip">←</span> {pt("Previous")}</a> : <span />}
      <span className="small muted">{pt("Page {page}", { page })}</span>
      {hasNext ? <a className="btn sm" href={href(page + 1)}>{pt("Next")} <span className="flip">→</span></a> : <span />}
    </nav>
  );
}

export const PAGE_SIZE = 50;
export function pageParam(v: string | undefined) {
  const n = Number(v);
  return Number.isInteger(n) && n >= 1 && n <= 10_000 ? n : 1;
}
