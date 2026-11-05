import type { Milestone, MilestoneKey } from "@/lib/milestones";

/** Circular progress (exam readiness). The ring fills clockwise; children sit in the middle. */
export function ProgressRing({ value, size = 112, stroke = 10, label, children }: { value: number; size?: number; stroke?: number; label: string; children?: React.ReactNode }) {
  const pct = Math.max(0, Math.min(1, value));
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  return (
    <div className="ring" style={{ width: size, height: size }} role="img" aria-label={label}>
      <svg viewBox={`0 0 ${size} ${size}`} width={size} height={size} aria-hidden="true">
        <circle className="ring-track" cx={size / 2} cy={size / 2} r={r} strokeWidth={stroke} fill="none" />
        <circle
          className="ring-fill"
          cx={size / 2}
          cy={size / 2}
          r={r}
          strokeWidth={stroke}
          fill="none"
          strokeLinecap="round"
          strokeDasharray={c}
          strokeDashoffset={c * (1 - pct)}
          transform={`rotate(-90 ${size / 2} ${size / 2})`}
        />
      </svg>
      <div className="ring-center">{children}</div>
    </div>
  );
}

/** Initials on a colour picked from the name, so the same person always has the same colour. */
export function Avatar({ name, size = 40 }: { name: string; size?: number }) {
  const initials = name.split(/\s+/).filter(Boolean).slice(0, 2).map((p) => p[0]!.toUpperCase()).join("") || "?";
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) % 360;
  return (
    <span className="avatar hue" style={{ width: size, height: size, ["--h" as string]: String(h), fontSize: size * 0.38 }} aria-hidden="true">
      {initials}
    </span>
  );
}

/** Small "in 2 days" / "now" pill. */
export function WhenPill({ children, live = false }: { children: React.ReactNode; live?: boolean }) {
  return <span className={`when-pill${live ? " live" : ""}`}>{children}</span>;
}

const BADGE_ICON: Record<MilestoneKey, string> = {
  firstLesson: "M5 17h14l-1.5-5h-11zM7 17v2M17 17v2M8 12l1.5-4h5L16 12", // car
  fiveLessons: "M12 3l2.6 5.3 5.9.9-4.3 4.1 1 5.8L12 16.4 6.8 19.1l1-5.8L3.5 9.2l5.9-.9z", // star
  tenHours: "M12 7v5l3 2M12 21a9 9 0 1 1 0-18 9 9 0 0 1 0 18z", // clock
  topRated: "M7 4h10v5a5 5 0 0 1-10 0zM5 5H3v2a3 3 0 0 0 4 2.8M19 5h2v2a3 3 0 0 1-4 2.8M12 14v4M8 21h8", // trophy
  halfway: "M4 20 12 4l8 16M8 13h8", // road
  examReady: "M5 21V4M5 4h11l-2 4 2 4H5", // flag
};

/** Horizontal strip of earned / locked milestones. */
export function Milestones({ items, label, labelFor }: { items: Milestone[]; label: string; labelFor: (m: Milestone) => { title: string; hint: string } }) {
  return (
    <ul className="badges" aria-label={label}>
      {items.map((m) => {
        const { title, hint } = labelFor(m);
        return (
          <li key={m.key} className={m.earned ? "earned" : "locked"}>
            <span className="badge-icon" aria-hidden="true">
              <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <path d={BADGE_ICON[m.key]} />
              </svg>
            </span>
            <strong>{title}</strong>
            <span className="small muted">{hint}</span>
            {m.progress && (
              <span className="badge-progress" aria-hidden="true">
                <span style={{ width: `${(m.progress[0] / m.progress[1]) * 100}%` }} />
              </span>
            )}
          </li>
        );
      })}
    </ul>
  );
}
