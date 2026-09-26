/**
 * "Road to your exam": the programme drawn as a road. Each level is a stretch
 * of road; the amber lane marking is how far the student has come and the car
 * sits at their position inside the current level. The road graphic is SVG
 * (mirrored for RTL by CSS); markers and labels are HTML with logical
 * positions so text never mirrors.
 */
import type { CSSProperties } from "react";

type Level = { position: number; name: string; done: number; total: number };

export function journeyPosition(levels: Level[], currentPosition: number | null, fallback: number) {
  if (!levels.length || !currentPosition) return fallback;
  const cur = levels.find((l) => l.position === currentPosition);
  const inLevel = cur && cur.total > 0 ? cur.done / cur.total : 0;
  const idx = levels.findIndex((l) => l.position === currentPosition);
  return Math.min(1, (idx + Math.min(inLevel, 0.95)) / levels.length);
}

export function RoadJourney({
  levels,
  currentPosition,
  percent,
  labels,
}: {
  levels: Level[];
  currentPosition: number | null;
  percent: number;
  labels: { title: string; start: string; exam: string; you: string; level: (position: number, name: string, done: number, total: number) => string };
}) {
  const at = journeyPosition(levels, currentPosition, percent);
  const n = levels.length || 1;
  const pct = (v: number) => `${(v * 100).toFixed(2)}%`;
  return (
    <figure className="journey" role="img" aria-label={`${labels.title}: ${Math.round(at * 100)}%`} style={{ "--at": pct(at) } as CSSProperties}>
      <div className="journey-road">
        <svg viewBox="0 0 100 20" preserveAspectRatio="none" aria-hidden>
          <line x1="4" y1="10" x2="96" y2="10" className="lane" />
          <line x1="4" y1="10" x2={4 + at * 92} y2="10" className="lane-done" />
        </svg>
        {levels.map((l, i) => {
          const x = i / n;
          const state = currentPosition && l.position < currentPosition ? "done" : l.position === currentPosition ? "current" : "todo";
          return (
            <span
              key={l.position}
              className={`journey-stop ${state}`}
              style={{ insetInlineStart: `calc(4% + ${x} * 92%)` }}
              data-tip={labels.level(l.position, l.name, l.done, l.total)}
              tabIndex={0}
            >
              <span className="num">{l.position}</span>
            </span>
          );
        })}
        <span className="journey-flag" style={{ insetInlineStart: "96%" }} data-tip={labels.exam} tabIndex={0} aria-hidden>
          <svg viewBox="0 0 16 16" width="16" height="16"><path d="M3 1v14" stroke="currentColor" strokeWidth="2" strokeLinecap="round" /><path d="M4 2h10v7H4z" className="flag" /><path d="M4 2h2.5v2.3H4zM9 2h2.5v2.3H9zM6.5 4.3H9v2.4H6.5zM11.5 4.3H14v2.4h-2.5zM4 6.7h2.5V9H4zM9 6.7h2.5V9H9z" className="flag-check" /></svg>
        </span>
        <span className="journey-car" style={{ insetInlineStart: `calc(4% + ${at} * 92%)` }} data-tip={labels.you} tabIndex={0}>
          <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden>
            <path d="M5 11l1.6-4.2A2 2 0 0 1 8.5 5.5h7a2 2 0 0 1 1.9 1.3L19 11" fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" />
            <rect x="3" y="11" width="18" height="6" rx="2" fill="currentColor" />
            <circle cx="7.5" cy="18" r="2" fill="currentColor" />
            <circle cx="16.5" cy="18" r="2" fill="currentColor" />
          </svg>
        </span>
      </div>
      <figcaption className="journey-ends">
        <span>{labels.start}</span>
        <span>{labels.exam}</span>
      </figcaption>
    </figure>
  );
}
