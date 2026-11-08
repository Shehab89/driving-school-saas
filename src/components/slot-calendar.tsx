"use client";
/**
 * Book / Reschedule calendar. Like the date pickers people know from other
 * apps: a date field opens a month calendar in a pop-up, and choosing a day
 * shows that day's free start times as buttons. Confirming calls a server
 * action that books in one database transaction; if someone took the time
 * first the times reload and say so.
 *
 * The first week is rendered on the server, so the times are visible
 * immediately; choosing a day outside that week loads the week starting there.
 */
import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { bookSlot, loadCalendar, moveLesson } from "@/app/student/lessons/actions";
import type { CalData, CalFreeCell } from "@/server/slot-calendar";
import { MonthGrid } from "./date-field";

export type CalLabels = {
  pick: string; free: string; taken: string; current: string; yours: string; prevWeek: string; nextWeek: string;
  noneThisWeek: string; newTime: string; approvalNote: string; confirm: string; confirmRequest: string; confirmBook: string;
  pickDay: string; pickTime: string; noneThisDay: string; prevMonth: string; nextMonth: string; freeDay: string; today: string; tomorrow: string; chooseDate: string; year: string;
  taken409: string; reason: string; optional: string; close: string; price: string | null;
  meetAt: string; endsAt: string; movedHint: string;
};

export function SlotCalendar({ initial, labels, popoverId }: { initial: CalData; labels: CalLabels; popoverId?: string }) {
  const router = useRouter();
  const root = useRef<HTMLDivElement>(null);
  const [data, setData] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const [sel, setSel] = useState<(CalFreeCell & { col: number }) | null>(null);
  const firstFree = (d: CalData) => d.days.find((x) => x.free > 0)?.iso ?? d.days[0]?.iso ?? d.today;
  const [day, setDay] = useState(() => firstFree(initial));
  const [reason, setReason] = useState("");
  const [loading, startLoading] = useTransition();
  const [saving, startSaving] = useTransition();

  /** Load the week starting at `start`; `pick` is the day to show afterwards (default: its first day with free time). */
  const load = (start?: string, pick?: string) =>
    startLoading(async () => {
      const r = await loadCalendar(data.lessonId, start);
      if (r.ok) {
        setData(r.data);
        setError(null);
        setSel(null);
        setDay(pick && r.data.days.some((d) => d.iso === pick) ? pick : firstFree(r.data));
      } else setError(r.message);
    });

  const chooseDay = (iso: string) => {
    const pop = document.getElementById(monthId);
    try {
      pop?.hidePopover();
    } catch {}
    setSel(null);
    if (data.days.some((d) => d.iso === iso)) setDay(iso);
    else load(iso, iso);
  };

  // Refresh when the pop-up is opened again, so it never shows stale availability.
  useEffect(() => {
    const pop = popoverId ? document.getElementById(popoverId) : null;
    if (!pop) return;
    let opened = false;
    const onToggle = (e: Event) => {
      if ((e as ToggleEvent).newState !== "open") return;
      setNotice(null);
      if (opened) load(data.days[0]?.iso, day);
      opened = true;
    };
    pop.addEventListener("toggle", onToggle);
    return () => pop.removeEventListener("toggle", onToggle);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [popoverId, data.days]);

  const confirm = () => {
    if (!sel) return;
    startSaving(async () => {
      const r = data.lessonId ? await moveLesson(data.lessonId, sel.slot, reason) : await bookSlot(sel.slot);
      if (r.ok) {
        setNotice({ tone: "ok", text: r.message });
        setSel(null);
        const pop = root.current?.closest<HTMLElement>("[popover]");
        setTimeout(() => {
          try {
            pop?.hidePopover();
          } catch {}
          router.replace(r.next);
        }, 900);
      } else {
        setNotice({ tone: "error", text: r.code === "slot_taken" ? labels.taken409 : r.message });
        if (r.code === "slot_taken") load(data.days[0]?.iso);
      }
    });
  };

  const name = `slot-${data.lessonId ?? "new"}`;
  const monthId = `${name}-month`;
  const col = data.days.findIndex((d) => d.iso === day);
  const dayInfo = data.days[col];
  // One button per possible start time; a free period's cells all point at slots, keep each once.
  const times = useMemo(() => {
    if (col < 0) return [];
    const seen = new Set<string>();
    return data.columns[col]!.flatMap((run) => run.cells ?? []).filter((c) => (seen.has(c.slot) ? false : (seen.add(c.slot), true)));
  }, [data, col]);

  return (
    <div className="scal" ref={root} aria-busy={loading || saving}>
      <div className="scal-head">
        <div>
          <h2>{data.title}</h2>
          {data.current && <p className="muted small"><span className="scal-chip current" aria-hidden /> {labels.current}: <span className="num">{data.current}</span></p>}
          {!data.current && labels.price && <p className="muted small">{labels.price}</p>}
        </div>
        {popoverId && <button type="button" className="scal-icon" popoverTarget={popoverId} popoverTargetAction="hide" aria-label={labels.close}>×</button>}
      </div>

      {error && <div className="flash error">{error}</div>}
      {notice && <div className={`flash ${notice.tone === "ok" ? "ok" : "error"}`} role="status">{notice.text}</div>}
      {!data.allowed && <div className="flash error">{data.blocked}</div>}

      {data.allowed && (
        <>
          <span className="eyebrow">{labels.pickDay}</span>
          <button type="button" className="scal-date" popoverTarget={monthId} aria-haspopup="dialog">
            <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true"><path d="M4 6h16v14H4zM4 10h16M8 3v4M16 3v4" /></svg>
            <span className="grow">{dayInfo?.long ?? day}</span>
            <span aria-hidden="true">▾</span>
          </button>
          <div id={monthId} popover="auto" className="sheet-pop scal-month-pop dp-pop">
            <div className="grab" aria-hidden />
            <MonthGrid
              key={day}
              selected={day}
              min={data.today}
              max={data.lastDay}
              locale={data.locale}
              labels={labels}
              onPick={chooseDay}
              dots={(d) => { const n = data.days.find((x) => x.iso === d)?.free; return n === undefined ? undefined : n > 0; }}
              dotLabel={labels.freeDay}
              closeId={monthId}
            />
          </div>

          <span className="eyebrow">{labels.pickTime}</span>
          <div className={`scal-times${loading ? " is-loading" : ""}`} role="radiogroup" aria-label={dayInfo?.long ?? day}>
            {times.length === 0 && <p className="muted small" style={{ margin: 0 }}>{labels.noneThisDay}</p>}
            {times.map((cell) => (
              <label key={cell.slot} className="scal-time-btn" title={cell.label}>
                <input type="radio" name={name} value={cell.slot} checked={sel?.slot === cell.slot} onChange={() => setSel({ ...cell, col })} aria-label={cell.label} />
                <span className="num">{cell.time}</span>
                {cell.moved && <span className="scal-moved" aria-label={labels.movedHint} title={labels.movedHint}>⇄</span>}
              </label>
            ))}
          </div>

          <div className="scal-foot">
            <p>
              <span className="muted small">{labels.newTime}: </span>
              <strong className="num">{sel ? sel.label : "—"}</strong>
            </p>
            {sel?.meet && (
              <p className="small" style={{ margin: "6px 0 0" }}>
                <span className="muted">{labels.meetAt}: </span><strong>{sel.meet}</strong>
                {sel.ends && sel.ends !== sel.meet && <><br /><span className="muted">{labels.endsAt}: </span><strong>{sel.ends}</strong></>}
              </p>
            )}
            {sel && data.lessonId && (
              <div className="field" style={{ margin: "10px 0 0" }}>
                <label htmlFor={`reason-${data.lessonId}`}>{labels.reason} <span className="muted small">({labels.optional})</span></label>
                <input id={`reason-${data.lessonId}`} value={reason} maxLength={300} onChange={(e) => setReason(e.target.value)} />
              </div>
            )}
            {data.requiresApproval && <p className="muted small">{labels.approvalNote}</p>}
            <button type="button" className="primary block" disabled={!sel || saving} onClick={confirm}>
              {data.lessonId ? (data.requiresApproval ? labels.confirmRequest : labels.confirm) : labels.confirmBook}
            </button>
          </div>
        </>
      )}
    </div>
  );
}

