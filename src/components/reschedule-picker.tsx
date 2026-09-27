"use client";
/**
 * Reschedule pop-up: a week table of start times. Green cells are times the
 * database offers for this lesson (tap to choose), grey cells are not
 * available. Confirming calls the moveLesson server action, which books
 * the new time in one transaction; if someone took the time in the meantime
 * the table reloads and says so.
 */
import { useCallback, useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { loadRescheduleGrid, moveLesson, type PickerData } from "@/app/student/lessons/actions";

export type PickerLabels = {
  title: string; current: string; pick: string; free: string; taken: string; yours: string;
  prevWeek: string; nextWeek: string; loading: string; noneThisWeek: string; newTime: string;
  approvalNote: string; confirm: string; confirmRequest: string; taken409: string; time: string;
  reason: string; optional: string; close: string;
};

export function ReschedulePicker({ lessonId, labels, popoverId }: { lessonId: string; labels: PickerLabels; popoverId?: string }) {
  const router = useRouter();
  const root = useRef<HTMLDivElement>(null);
  const [data, setData] = useState<PickerData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const [selected, setSelected] = useState<{ slot: string; label: string } | null>(null);
  const [reason, setReason] = useState("");
  const [loading, startLoading] = useTransition();
  const [saving, startSaving] = useTransition();

  const load = useCallback(
    (start?: string) =>
      startLoading(async () => {
        const r = await loadRescheduleGrid(lessonId, start);
        if (r.ok) {
          setData(r.data);
          setError(null);
          setSelected((sel) => (sel && r.data.cells.some((row) => row.some((c) => c.slot === sel.slot)) ? sel : null));
        } else setError(r.message);
      }),
    [lessonId],
  );

  // Load when the pop-up opens (or right away on a full page), so the table is always fresh.
  useEffect(() => {
    const pop = popoverId ? document.getElementById(popoverId) : null;
    if (!pop) {
      load();
      return;
    }
    const onToggle = (e: Event) => {
      if ((e as ToggleEvent).newState === "open") {
        setNotice(null);
        load();
      }
    };
    pop.addEventListener("toggle", onToggle);
    return () => pop.removeEventListener("toggle", onToggle);
  }, [popoverId, load]);

  const confirm = () => {
    if (!selected) return;
    startSaving(async () => {
      const r = await moveLesson(lessonId, selected.slot, reason);
      if (r.ok) {
        setNotice({ tone: "ok", text: r.message });
        setSelected(null);
        const pop = root.current?.closest<HTMLElement>("[popover]");
        setTimeout(() => {
          try {
            pop?.hidePopover();
          } catch {}
          router.replace(`/student?ok=${encodeURIComponent(r.message)}`);
        }, 900);
      } else {
        setNotice({ tone: "error", text: r.code === "slot_taken" ? labels.taken409 : r.message });
        if (r.code === "slot_taken") load(data?.days[0]?.iso);
      }
    });
  };

  // Rows where the school is closed every day of the week carry no information: skip them.
  const rows = data ? data.times.map((time, i) => ({ time, cells: data.cells[i]! })).filter((r) => r.cells.some((c) => c.state !== "closed")) : [];

  return (
    <div className="rp" ref={root} aria-busy={loading || saving}>
      <div className="rp-head">
        <div>
          <h2 style={{ margin: 0 }}>{data ? labels.title.replace("{number}", String(data.lessonNumber)) : labels.loading}</h2>
          {data && <p className="muted small" style={{ margin: "2px 0 0" }}>{labels.current}: <span className="num">{data.current}</span></p>}
        </div>
        {popoverId && (
          <button type="button" className="icon-btn" popoverTarget={popoverId} popoverTargetAction="hide" aria-label={labels.close}>×</button>
        )}
      </div>

      {error && <div className="flash error">{error}</div>}
      {notice && <div className={`flash ${notice.tone === "ok" ? "ok" : "error"}`} role="status">{notice.text}</div>}

      {data && !data.allowed && <div className="flash error">{data.blocked}</div>}

      {data && data.allowed && (
        <>
          <div className="rp-nav">
            <button type="button" className="icon-btn" disabled={!data.prevStart || loading} onClick={() => load(data.prevStart!)} aria-label={labels.prevWeek}>‹</button>
            <strong className="num">{data.range}</strong>
            <button type="button" className="icon-btn" disabled={!data.nextStart || loading} onClick={() => load(data.nextStart!)} aria-label={labels.nextWeek}>›</button>
          </div>
          <p className="muted small" style={{ margin: "0 0 8px" }}>{data.freeCount > 0 ? labels.pick : labels.noneThisWeek}</p>

          <div className="rp-legend" aria-hidden>
            <span><i className="rp-cell free" /> {labels.free}</span>
            <span><i className="rp-cell taken" /> {labels.taken}</span>
            <span><i className="rp-cell current" /> {labels.current}</span>
          </div>

          <div className={`rp-scroll${loading ? " is-loading" : ""}`}>
            <table className="rp-table">
              <thead>
                <tr>
                  <th scope="col" className="rp-time"><span className="sr-only">{labels.time}</span></th>
                  {data.days.map((d) => (
                    <th key={d.iso} scope="col" className={d.today ? "today" : undefined}>
                      <span className="rp-dow">{d.dow}</span>
                      <span className="rp-date num">{d.date}</span>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.time}>
                    <th scope="row" className="rp-time num">{r.time.endsWith(":00") ? r.time : ""}</th>
                    {r.cells.map((c, j) => (
                      <td key={j}>
                        {c.state === "free" ? (
                          <button
                            type="button"
                            className={`rp-cell free${selected?.slot === c.slot ? " selected" : ""}`}
                            aria-pressed={selected?.slot === c.slot}
                            aria-label={`${c.label} – ${labels.free}`}
                            title={c.label}
                            onClick={() => setSelected({ slot: c.slot!, label: c.label })}
                          >
                            <span className="num">{r.time}</span>
                          </button>
                        ) : (
                          <span className={`rp-cell ${c.state}`} title={`${c.label} – ${c.state === "current" ? labels.current : c.state === "mine" ? labels.yours : labels.taken}`} aria-label={c.state === "current" ? `${c.label} – ${labels.current}` : undefined} />
                        )}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="rp-foot">
            <p style={{ margin: 0 }}>
              <span className="muted small">{labels.newTime}: </span>
              <strong className="num">{selected ? selected.label : "—"}</strong>
            </p>
            {selected && (
              <div className="field" style={{ margin: "10px 0 0" }}>
                <label htmlFor={`reason-${lessonId}`}>{labels.reason} <span className="muted small">({labels.optional})</span></label>
                <input id={`reason-${lessonId}`} value={reason} maxLength={300} onChange={(e) => setReason(e.target.value)} />
              </div>
            )}
            {data.requiresApproval && <p className="muted small" style={{ margin: "8px 0 0" }}>{labels.approvalNote}</p>}
            <button type="button" className="primary block" style={{ marginTop: 12 }} disabled={!selected || saving} onClick={confirm}>
              {data.requiresApproval ? labels.confirmRequest : labels.confirm}
            </button>
          </div>
        </>
      )}
      {!data && !error && <div className="rp-skeleton" aria-hidden />}
    </div>
  );
}
