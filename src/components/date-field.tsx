"use client";
/**
 * The one date picker used across the apps (same as the student's booking):
 * a field that shows the chosen day and opens a month calendar in a pop-up.
 * Days outside [min, max] are disabled; `dots` marks days worth a look (free
 * time, lessons). Works inside forms: the value is posted from a hidden input.
 */
import { useId, useState } from "react";

import type { DateFieldLabels } from "./date-field-labels";
export type { DateFieldLabels };

const utc = (y: number, m: number, d: number) => new Date(Date.UTC(y, m - 1, d));
const iso = (d: Date) => d.toISOString().slice(0, 10);
const todayIso = () => {
  const n = new Date();
  return iso(utc(n.getFullYear(), n.getMonth() + 1, n.getDate()));
};

export function DateField({
  id, name, defaultValue = "", value, min, max, locale, labels, onChange, dots, dotLabel, required, years,
}: {
  id?: string; name?: string; defaultValue?: string; value?: string; min?: string; max?: string; locale: string; labels: DateFieldLabels;
  onChange?: (iso: string) => void; dots?: (iso: string) => boolean | undefined; dotLabel?: string; required?: boolean;
  /** Show a year menu (e.g. date of birth). */
  years?: [number, number];
}) {
  const auto = useId().replace(/:/g, "");
  const popId = `df-${id ?? auto}`;
  const [own, setOwn] = useState(defaultValue);
  const current = value ?? own;
  const pretty = current ? new Intl.DateTimeFormat(locale, { timeZone: "UTC", weekday: "long", day: "numeric", month: "long", year: "numeric" }).format(new Date(`${current}T00:00:00Z`)) : labels.chooseDate;
  const pick = (d: string) => {
    try {
      document.getElementById(popId)?.hidePopover();
    } catch {}
    if (value === undefined) setOwn(d);
    onChange?.(d);
  };
  return (
    <>
      {name && <input type="hidden" name={name} value={current} required={required} />}
      <button type="button" id={id} className={`scal-date${current ? "" : " empty"}`} popoverTarget={popId} aria-haspopup="dialog">
        <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true"><path d="M4 6h16v14H4zM4 10h16M8 3v4M16 3v4" /></svg>
        <span className="grow">{pretty}</span>
        <span aria-hidden="true">▾</span>
      </button>
      <div id={popId} popover="auto" className="sheet-pop scal-month-pop">
        <div className="grab" aria-hidden />
        <h2 style={{ margin: "0 0 8px" }}>{labels.pickDay}</h2>
        <MonthGrid key={current} selected={current} min={min} max={max} locale={locale} labels={labels} onPick={pick} dots={dots} dotLabel={dotLabel} years={years} closeId={popId} />
      </div>
    </>
  );
}

/** Month calendar (Monday first) used by DateField and the booking calendar. */
export function MonthGrid({
  selected, min, max, locale, labels, onPick, dots, dotLabel, years, closeId,
}: {
  selected: string; min?: string; max?: string; locale: string; labels: DateFieldLabels; onPick: (iso: string) => void;
  dots?: (iso: string) => boolean | undefined; dotLabel?: string; years?: [number, number]; closeId: string;
}) {
  const today = todayIso();
  const [month, setMonth] = useState(() => (selected || (min && min > today ? min : max && max < today ? max : today)).slice(0, 7));
  const [y, m] = month.split("-").map(Number) as [number, number];
  const first = utc(y, m, 1);
  const lead = (first.getUTCDay() + 6) % 7;
  const daysIn = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const fmt = (o: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat(locale, { timeZone: "UTC", ...o });
  const title = fmt({ month: "long", year: "numeric" }).format(first);
  const weekdays = Array.from({ length: 7 }, (_, i) => fmt({ weekday: "narrow" }).format(utc(2024, 1, 1 + i))); // 1 Jan 2024 was a Monday
  const go = (yy: number, mm: number) => setMonth(iso(utc(yy, mm, 1)).slice(0, 7));
  const canPrev = !min || iso(utc(y, m, 0)) >= min;
  const canNext = !max || iso(utc(y, m + 1, 1)) <= max;
  const todayOk = (!min || today >= min) && (!max || today <= max);

  return (
    <div className="mcal">
      <div className="mcal-head">
        <button type="button" className="scal-icon" onClick={() => go(y, m - 1)} disabled={!canPrev} aria-label={labels.prevMonth}><span className="flip">‹</span></button>
        {years ? (
          <span className="row" style={{ gap: 6 }}>
            <strong>{fmt({ month: "long" }).format(first)}</strong>
            <select value={y} onChange={(e) => go(Number(e.target.value), m)} aria-label={labels.year} style={{ width: "auto" }}>
              {Array.from({ length: years[1] - years[0] + 1 }, (_, i) => years[1] - i).map((yy) => <option key={yy} value={yy}>{yy}</option>)}
            </select>
          </span>
        ) : (
          <strong>{title}</strong>
        )}
        <button type="button" className="scal-icon" onClick={() => go(y, m + 1)} disabled={!canNext} aria-label={labels.nextMonth}><span className="flip">›</span></button>
      </div>
      <div className="mcal-grid" role="grid" aria-label={title}>
        {weekdays.map((w, i) => <span key={i} className="mcal-wd" aria-hidden="true">{w}</span>)}
        {Array.from({ length: lead }, (_, i) => <span key={`b${i}`} />)}
        {Array.from({ length: daysIn }, (_, i) => {
          const d = iso(utc(y, m, i + 1));
          const out = (!!min && d < min) || (!!max && d > max);
          const dot = out || !dots ? undefined : dots(d);
          const cls = ["mcal-day", d === selected ? "sel" : "", d === today ? "today" : "", dot === false ? "none" : "", dot ? "has" : ""].filter(Boolean).join(" ");
          return (
            <button key={d} type="button" className={cls} disabled={out} aria-pressed={d === selected} onClick={() => onPick(d)}>
              <span className="num">{i + 1}</span>
            </button>
          );
        })}
      </div>
      <div className="mcal-foot">
        {dotLabel ? <span className="muted small"><i className="mcal-dot" /> {dotLabel}</span> : <span />}
        <span className="row" style={{ gap: 6 }}>
          {todayOk && <button type="button" className="sm" onClick={() => onPick(today)}>{labels.today}</button>}
          <button type="button" className="sm ghost" popoverTarget={closeId} popoverTargetAction="hide">{labels.close}</button>
        </span>
      </div>
    </div>
  );
}
