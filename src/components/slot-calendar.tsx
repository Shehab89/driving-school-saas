"use client";
/**
 * Book / Reschedule calendar. A week grid with days as columns and time
 * running down: free periods are green blocks, busy or closed time is grey.
 * Tapping inside a green block picks the lesson starting there (the chosen
 * lesson is drawn over the calendar). Confirming calls a server action that
 * books in one database transaction; if someone took the time first the
 * calendar reloads and says so.
 *
 * The first week is rendered on the server, so the calendar is visible
 * immediately (and without JavaScript); the radio inputs keep the selection.
 */
import { useEffect, useRef, useState, useTransition, type CSSProperties } from "react";
import { useRouter } from "next/navigation";
import { bookSlot, loadCalendar, moveLesson } from "@/app/student/lessons/actions";
import type { CalData, CalFreeCell } from "@/server/slot-calendar";

export type CalLabels = {
  pick: string; free: string; taken: string; current: string; yours: string; prevWeek: string; nextWeek: string;
  noneThisWeek: string; newTime: string; approvalNote: string; confirm: string; confirmRequest: string; confirmBook: string;
  taken409: string; reason: string; optional: string; close: string; price: string | null;
};

export function SlotCalendar({ initial, labels, popoverId }: { initial: CalData; labels: CalLabels; popoverId?: string }) {
  const router = useRouter();
  const root = useRef<HTMLDivElement>(null);
  const [data, setData] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const [sel, setSel] = useState<(CalFreeCell & { col: number }) | null>(null);
  const [reason, setReason] = useState("");
  const [loading, startLoading] = useTransition();
  const [saving, startSaving] = useTransition();

  const load = (start?: string) =>
    startLoading(async () => {
      const r = await loadCalendar(data.lessonId, start);
      if (r.ok) {
        setData(r.data);
        setError(null);
        setSel(null);
      } else setError(r.message);
    });

  // Refresh when the pop-up is opened again, so it never shows stale availability.
  useEffect(() => {
    const pop = popoverId ? document.getElementById(popoverId) : null;
    if (!pop) return;
    let opened = false;
    const onToggle = (e: Event) => {
      if ((e as ToggleEvent).newState !== "open") return;
      setNotice(null);
      if (opened) load(data.days[0]?.iso);
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
          router.replace(`/student?ok=${encodeURIComponent(r.message)}`);
        }, 900);
      } else {
        setNotice({ tone: "error", text: r.code === "slot_taken" ? labels.taken409 : r.message });
        if (r.code === "slot_taken") load(data.days[0]?.iso);
      }
    });
  };

  const rows = data.times.length;
  const name = `slot-${data.lessonId ?? "new"}`;

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
          <div className="scal-nav">
            <button type="button" className="scal-icon" disabled={!data.prevStart || loading} onClick={() => load(data.prevStart!)} aria-label={labels.prevWeek}>‹</button>
            <strong className="num">{data.range}</strong>
            <button type="button" className="scal-icon" disabled={!data.nextStart || loading} onClick={() => load(data.nextStart!)} aria-label={labels.nextWeek}>›</button>
          </div>
          <div className="scal-legend">
            <span><i className="scal-chip free" /> {labels.free}</span>
            <span><i className="scal-chip taken" /> {labels.taken}</span>
            {data.current && <span><i className="scal-chip current" /> {labels.current}</span>}
            <span className="muted">{data.freeCount > 0 ? labels.pick : labels.noneThisWeek}</span>
          </div>

          <div className={`scal-scroll${loading ? " is-loading" : ""}`}>
            <div className="scal-grid" role="radiogroup" aria-label={data.range} style={{ "--rows": rows } as CSSProperties}>
              <div className="scal-corner" />
              {data.days.map((d, c) => (
                <div key={d.iso} className={`scal-day${d.today ? " today" : ""}`} style={{ gridColumn: c + 2 }}>
                  <span>{d.dow}</span>
                  <strong className="num">{d.date}</strong>
                </div>
              ))}
              {data.times.map((time, r) =>
                time.endsWith(":00") ? (
                  <div key={time} className="scal-time num" style={{ gridRow: r + 2, transform: r === 0 ? "none" : undefined }}>{time}</div>
                ) : null,
              )}
              <div className="scal-lines" style={{ gridRow: `2 / span ${rows}` }} aria-hidden />

              {data.columns.map((runs, c) =>
                runs.map((run) =>
                  run.state === "free" ? (
                    <div key={`${c}-${run.from}`} className="scal-block free" style={{ gridColumn: c + 2, gridRow: `${run.from + 2} / span ${run.rows}`, "--n": run.rows } as CSSProperties}>
                      {run.rows >= 2 && <PeriodLabel text={run.label!} />}
                      {run.cells!.map((cell) => (
                        <label key={cell.row} className="scal-hit" title={cell.label}>
                          <input
                            type="radio"
                            name={name}
                            value={cell.slot}
                            checked={sel?.slot === cell.slot && sel.row === cell.row && sel.col === c}
                            onChange={() => setSel({ ...cell, col: c })}
                            aria-label={cell.label}
                          />
                        </label>
                      ))}
                    </div>
                  ) : (
                    <div
                      key={`${c}-${run.from}`}
                      className={`scal-block ${run.state}`}
                      style={{ gridColumn: c + 2, gridRow: `${run.from + 2} / span ${run.rows}` }}
                      title={run.label ?? undefined}
                    >
                      {run.label && run.state !== "taken" && run.rows >= 2 && <span className="scal-label">{run.label}</span>}
                    </div>
                  ),
                ),
              )}

              {sel && (
                <div
                  className="scal-selected"
                  style={{ gridColumn: sel.col + 2, gridRow: `${Math.max(0, Math.floor(sel.slotRow)) + 2} / span ${Math.max(1, Math.round(sel.slotRows))}` }}
                  aria-hidden
                >
                  <span className="num">{sel.label.split(" ").slice(-1)[0]}</span>
                </div>
              )}
            </div>
          </div>

          <div className="scal-foot">
            <p>
              <span className="muted small">{labels.newTime}: </span>
              <strong className="num">{sel ? sel.label : "—"}</strong>
            </p>
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

/** "09:30–15:00" as two short lines so it fits a narrow day column. */
function PeriodLabel({ text }: { text: string }) {
  const [from, to] = text.replace(/[\u2066\u2069]/g, "").split("–");
  return (
    <span className="scal-label period num" dir="ltr">
      <span>{from}</span>
      {to && <span>–{to}</span>}
    </span>
  );
}
