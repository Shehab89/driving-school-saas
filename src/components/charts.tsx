/**
 * Small, dependency-free charts rendered on the server as HTML/SVG.
 *
 * Rules they follow (see docs/ARCHITECTURE.md → Charts):
 *  - one neutral ink for data, the brand amber only for the "now" mark;
 *  - thin marks (bars ≤ 24px, 4px rounded data end, 2px lines, 8px markers);
 *  - text never wears the series colour; every mark has a tooltip ([data-tip],
 *    shown by <ChartTips/>) and every chart has a table view;
 *  - layout uses logical properties so charts mirror in RTL.
 */
import type { CSSProperties, ReactNode } from "react";

export type Col = { key: string; label: string; value: number; tip: string; highlight?: boolean };

function niceMax(v: number) {
  if (v <= 0) return 1;
  const pow = 10 ** Math.floor(Math.log10(v));
  const n = v / pow;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10) * pow;
}

/** Vertical columns with a hairline grid. `labelEvery` thins out the x labels. */
export function ColumnChart({
  data,
  format,
  ariaLabel,
  height = 160,
  labelEvery = 1,
  labelValues = "highlight",
}: {
  data: Col[];
  format: (v: number) => string;
  ariaLabel: string;
  height?: number;
  labelEvery?: number;
  labelValues?: "highlight" | "all";
}) {
  const max = niceMax(Math.max(...data.map((d) => d.value)));
  const ticks = [max, max / 2, 0];
  return (
    <figure className="ch-cols" aria-label={ariaLabel} role="img" style={{ "--h": `${height}px` } as CSSProperties}>
      <div className="ch-grid" aria-hidden>
        {ticks.map((t) => (
          <div key={t} className="ch-tick"><span className="num">{format(t)}</span></div>
        ))}
      </div>
      <div className="ch-plot">
        {data.map((d, i) => {
          const pct = (d.value / max) * 100;
          const show = labelValues === "all" ? d.value > 0 : d.highlight;
          return (
            <div key={d.key} className={`ch-col${d.highlight ? " hi" : ""}`} data-tip={d.tip} tabIndex={0}>
              <div className="ch-bar-wrap">
                {show && <span className="ch-val num">{format(d.value)}</span>}
                <span className="ch-bar" style={{ height: `${Math.max(pct, d.value > 0 ? 2 : 0)}%` }} />
              </div>
              <span className="ch-x">{d.highlight || (i % labelEvery === 0 && !(labelEvery > 1 && data[i + 1]?.highlight)) ? d.label : "\u00a0"}</span>
            </div>
          );
        })}
      </div>
    </figure>
  );
}

/** A tiny trend line; the last point wears the accent. Fixed size so markers stay round. */
export function Sparkline({
  values,
  tips,
  ariaLabel,
  width = 132,
  height = 36,
  min,
  max,
}: {
  values: number[];
  tips?: string[];
  ariaLabel: string;
  width?: number;
  height?: number;
  min?: number;
  max?: number;
}) {
  if (values.length === 0) return null;
  const pad = 5;
  const lo = min ?? Math.min(...values);
  const hi = max ?? Math.max(...values);
  const span = hi - lo || 1;
  const x = (i: number) => (values.length === 1 ? width / 2 : pad + (i * (width - 2 * pad)) / (values.length - 1));
  const y = (v: number) => height - pad - ((v - lo) / span) * (height - 2 * pad);
  const d = values.map((v, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ");
  const area = `${d} L${x(values.length - 1).toFixed(1)},${height} L${x(0).toFixed(1)},${height} Z`;
  const last = values.length - 1;
  const step = values.length > 1 ? (width - 2 * pad) / (values.length - 1) : width;
  return (
    <svg className="ch-spark" width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="img" aria-label={ariaLabel}>
      <path d={area} className="ch-spark-area" />
      <path d={d} className="ch-spark-line" />
      <circle cx={x(last)} cy={y(values[last]!)} r={4} className="ch-spark-dot" />
      {tips &&
        values.map((v, i) => (
          <rect key={i} x={x(i) - step / 2} y={0} width={Math.max(step, 24)} height={height} fill="transparent" data-tip={tips[i]}>
            <title>{tips[i]}</title>
          </rect>
        ))}
    </svg>
  );
}

/** KPI tile: the number is the chart; an optional sparkline and change vs the previous period. */
export function StatTile({ label, value, delta, children }: { label: string; value: ReactNode; delta?: { now: number; prev: number; label: string }; children?: ReactNode }) {
  let change: ReactNode = null;
  if (delta) {
    const pct = delta.prev > 0 ? Math.round(((delta.now - delta.prev) / delta.prev) * 100) : null;
    const dir = pct === null || pct === 0 ? "flat" : pct > 0 ? "up" : "down";
    change = (
      <span className={`ch-delta ${dir}`}>
        <span aria-hidden>{dir === "up" ? "▲" : dir === "down" ? "▼" : "•"}</span>
        <span className="num">{pct === null ? "–" : `${pct > 0 ? "+" : ""}${pct}%`}</span> {delta.label}
      </span>
    );
  }
  return (
    <div className="card ch-tile">
      <div className="ch-tile-label">{label}</div>
      <div className="ch-tile-value num">{value}</div>
      {change}
      {children && <div className="ch-tile-chart">{children}</div>}
    </div>
  );
}

/** Weekday x hour grid on a single-hue amber ramp (5 steps, validated). */
export function Heatmap({
  rows,
  cols,
  value,
  tip,
  ariaLabel,
  legend,
}: {
  rows: { key: number; label: string }[];
  cols: { key: number; label: string }[];
  value: (row: number, col: number) => number;
  tip: (row: number, col: number, v: number) => string;
  ariaLabel: string;
  legend: [string, string];
}) {
  let max = 0;
  for (const r of rows) for (const c of cols) max = Math.max(max, value(r.key, c.key));
  const step = (v: number) => (v <= 0 ? 0 : Math.min(5, Math.ceil((v / (max || 1)) * 5)));
  return (
    <figure className="ch-heat" role="img" aria-label={ariaLabel}>
      <div className="ch-heat-grid" style={{ gridTemplateColumns: `auto repeat(${cols.length}, minmax(0, 1fr))` }}>
        <span />
        {cols.map((c, i) => (
          <span key={c.key} className="ch-heat-x num">{i % 2 === 0 ? c.label : ""}</span>
        ))}
        {rows.map((r) => (
          <Row key={r.key}>
            <span className="ch-heat-y">{r.label}</span>
            {cols.map((c) => {
              const v = value(r.key, c.key);
              return <span key={c.key} className={`ch-cell h${step(v)}`} data-tip={tip(r.key, c.key, v)} tabIndex={-1} />;
            })}
          </Row>
        ))}
      </div>
      <figcaption className="ch-ramp-legend">
        <span>{legend[0]}</span>
        {[0, 1, 2, 3, 4, 5].map((s) => <span key={s} className={`ch-cell h${s}`} aria-hidden />)}
        <span>{legend[1]}</span>
      </figcaption>
    </figure>
  );
}
function Row({ children }: { children: ReactNode }) {
  return <>{children}</>;
}

/** One bar split into parts (status colours + labels, 2px gaps). */
export function SplitBar({ parts, ariaLabel }: { parts: { key: string; label: string; value: number; display: string; tone: "good" | "warn" | "bad" }[]; ariaLabel: string }) {
  const total = parts.reduce((a, p) => a + p.value, 0) || 1;
  return (
    <figure className="ch-split" role="img" aria-label={ariaLabel}>
      <div className="ch-split-bar">
        {parts.filter((p) => p.value > 0).map((p) => (
          <span key={p.key} className={`ch-seg ${p.tone}`} style={{ flexGrow: p.value }} data-tip={`${p.label}: ${p.display} (${Math.round((p.value / total) * 100)}%)`} tabIndex={0} />
        ))}
      </div>
      <figcaption className="ch-split-legend">
        {parts.map((p) => (
          <span key={p.key} className="ch-key">
            <span className={`ch-swatch ${p.tone}`} aria-hidden />
            <span>{p.label}</span>
            <strong className="num">{p.display}</strong>
            <span className="muted num">{Math.round((p.value / total) * 100)}%</span>
          </span>
        ))}
      </figcaption>
    </figure>
  );
}

/** Horizontal bars on a track: each row is label, bar, value. */
export function BarList({ items, ariaLabel }: { items: { key: string; label: ReactNode; value: number; max: number; display: string; tip: string; muted?: boolean }[]; ariaLabel: string }) {
  return (
    <ul className="ch-barlist" aria-label={ariaLabel}>
      {items.map((it) => (
        <li key={it.key} data-tip={it.tip} tabIndex={0}>
          <span className="ch-bl-label">{it.label}</span>
          <span className="ch-bl-track">
            <span className={`ch-bl-bar${it.muted ? " muted" : ""}`} style={{ width: `${it.max > 0 ? Math.min(100, (it.value / it.max) * 100) : 0}%` }} />
          </span>
          <span className="ch-bl-value num">{it.display}</span>
        </li>
      ))}
    </ul>
  );
}

/** The table view every chart offers. */
export function ChartTable({ summary, head, rows }: { summary: string; head: string[]; rows: (string | number)[][] }) {
  return (
    <details className="ch-table">
      <summary>{summary}</summary>
      <div className="table-wrap">
        <table>
          <thead><tr>{head.map((h) => <th key={h}>{h}</th>)}</tr></thead>
          <tbody>{rows.map((r, i) => <tr key={i}>{r.map((c, j) => <td key={j} className={typeof c === "number" ? "num" : undefined}>{c}</td>)}</tr>)}</tbody>
        </table>
      </div>
    </details>
  );
}
