"use client";
/**
 * Schedule board: a time grid (day / week) and a month overview.
 * - Switching day/week/month and moving within the loaded range happens
 *   instantly on the client (the URL is kept in sync); going outside the
 *   range loads the next month from the server.
 * - Swipe left/right on phones to move a day (or week).
 * - Each lesson opens a pop-up (native [popover], so it also works before
 *   JavaScript has loaded) with the key facts and quick actions.
 * The same markup renders on the server, so the first paint is complete.
 */
import { DateTime } from "luxon";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { confirmAction, startAction } from "@/app/(staff)/lessons/[id]/actions";

export type BoardView = "day" | "week" | "month";

export interface BoardLesson {
  id: string;
  start: string; // ISO
  end: string;
  status: string;
  statusLabel: string;
  statusTone: string;
  student: string;
  studentPhone: string | null;
  lessonLabel: string;
  levelLabel: string;
  vehicle: string;
  instructor: string | null;
  color: string | null;
  canConfirm: boolean;
  canStart: boolean;
  feedback: "none" | "give" | "edit";
}

export interface BoardLabels {
  today: string;
  day: string;
  week: string;
  month: string;
  previous: string;
  next: string;
  noLessons: string;
  openLesson: string;
  call: string;
  confirm: string;
  start: string;
  giveFeedback: string;
  editFeedback: string;
  close: string;
  lessonsCount: string; // "{count} lessons"
}

interface Props {
  lessons: BoardLesson[];
  zone: string;
  tag: string;
  view: BoardView;
  focus: string; // YYYY-MM-DD
  rangeStart: string; // YYYY-MM-DD inclusive
  rangeEnd: string; // YYYY-MM-DD exclusive
  basePath: string;
  extraQuery?: string;
  feedbackBase: string; // e.g. "/instructor/feedback"
  labels: BoardLabels;
}

const PPH = 60; // pixels per hour

function fill(tpl: string, n: number) {
  return tpl.replace("{count}", String(n));
}

/** Side-by-side lanes for overlapping lessons in one column. */
function lanes(items: BoardLesson[]) {
  const sorted = [...items].sort((a, b) => a.start.localeCompare(b.start));
  const out = new Map<string, { lane: number; lanes: number }>();
  let cluster: Array<[BoardLesson, number]> = [];
  let ends: string[] = [];
  let clusterEnd = "";
  const flush = () => {
    for (const [l, lane] of cluster) out.set(l.id, { lane, lanes: ends.length });
    cluster = [];
    ends = [];
  };
  for (const l of sorted) {
    if (cluster.length && l.start >= clusterEnd) flush();
    let lane = ends.findIndex((e) => e <= l.start);
    if (lane === -1) {
      lane = ends.length;
      ends.push(l.end);
    } else ends[lane] = l.end;
    cluster.push([l, lane]);
    clusterEnd = cluster.length === 1 || l.end > clusterEnd ? l.end : clusterEnd;
  }
  if (cluster.length) flush();
  return out;
}

export function ScheduleBoard(props: Props) {
  const { zone, tag, labels, lessons } = props;
  const [view, setView] = useState<BoardView>(props.view);
  const [focus, setFocus] = useState(props.focus);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const scroller = useRef<HTMLDivElement>(null);
  const touch = useRef<{ x: number; y: number } | null>(null);

  useEffect(() => {
    const id = setInterval(() => setNowMs(Date.now()), 60_000);
    return () => clearInterval(id);
  }, []);

  const dt = useCallback((iso: string) => DateTime.fromISO(iso, { zone }).setLocale(tag), [zone, tag]);
  const f = dt(focus);
  const now = DateTime.fromMillis(nowMs, { zone }).setLocale(tag);

  const url = useCallback(
    (v: BoardView, d: string) => `${props.basePath}?view=${v}&date=${d}${props.extraQuery ?? ""}`,
    [props.basePath, props.extraQuery],
  );

  const days = useMemo(() => {
    if (view === "day") return [f.startOf("day")];
    if (view === "week") return Array.from({ length: 7 }, (_, i) => f.startOf("week").plus({ days: i }));
    const first = f.startOf("month").startOf("week");
    const last = f.endOf("month").endOf("week");
    const out: DateTime[] = [];
    for (let d = first; d <= last; d = d.plus({ days: 1 })) out.push(d);
    return out;
  }, [view, f]);

  const byDay = useMemo(() => {
    const m = new Map<string, BoardLesson[]>();
    for (const l of lessons) {
      const k = dt(l.start).toISODate()!;
      m.set(k, [...(m.get(k) ?? []), l]);
    }
    return m;
  }, [lessons, dt]);

  /** Move client-side when the target is inside the loaded range, otherwise load it. */
  const go = useCallback(
    (v: BoardView, d: DateTime, e?: { preventDefault(): void }) => {
      const iso = d.toISODate()!;
      const needStart = v === "month" ? d.startOf("month").startOf("week") : v === "week" ? d.startOf("week") : d;
      const needEnd = v === "month" ? d.endOf("month").endOf("week") : v === "week" ? d.startOf("week").plus({ days: 6 }) : d;
      const inside = needStart.toISODate()! >= props.rangeStart && needEnd.toISODate()! < props.rangeEnd;
      if (!inside) return; // let the link navigate
      e?.preventDefault();
      setView(v);
      setFocus(iso);
      window.history.replaceState(null, "", url(v, iso));
    },
    [props.rangeStart, props.rangeEnd, url],
  );

  const step = view === "day" ? { days: 1 } : view === "week" ? { weeks: 1 } : { months: 1 };
  const prev = f.minus(step);
  const next = f.plus(step);

  // Time window: 07:00–21:00, widened to fit any lesson.
  const { startHour, endHour } = useMemo(() => {
    let s = 7;
    let e = 21;
    for (const l of lessons) {
      s = Math.min(s, dt(l.start).hour);
      const end = dt(l.end);
      e = Math.max(e, end.hour + (end.minute > 0 ? 1 : 0));
    }
    return { startHour: s, endHour: Math.min(24, e) };
  }, [lessons, dt]);

  // Scroll the grid to "now" (today) or to the first lesson.
  useEffect(() => {
    if (!scroller.current || view === "month") return;
    const visible = days.flatMap((d) => byDay.get(d.toISODate()!) ?? []);
    const showsToday = days.some((d) => d.hasSame(now, "day"));
    const hour = showsToday ? now.hour + now.minute / 60 : visible.length ? Math.min(...visible.map((l) => dt(l.start).hour)) : 8;
    scroller.current.scrollTop = Math.max(0, (hour - startHour - 1) * PPH);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, focus]);

  const title =
    view === "day" ? f.toFormat("cccc d LLLL") : view === "week" ? `${days[0]!.toFormat("d LLL")} – ${days[6]!.toFormat("d LLL yyyy")}` : f.toFormat("LLLL yyyy");

  const onTouchStart = (e: React.TouchEvent) => {
    const t = e.touches[0];
    if (t) touch.current = { x: t.clientX, y: t.clientY };
  };
  const onTouchEnd = (e: React.TouchEvent) => {
    const t = e.changedTouches[0];
    const s = touch.current;
    touch.current = null;
    if (!t || !s) return;
    const dx = t.clientX - s.x;
    if (Math.abs(dx) < 60 || Math.abs(t.clientY - s.y) > 40) return;
    const rtl = document.documentElement.dir === "rtl";
    const forward = rtl ? dx > 0 : dx < 0;
    const target = forward ? next : prev;
    const inRange = target.toISODate()! >= props.rangeStart && target.toISODate()! < props.rangeEnd;
    if (inRange) go(view, target);
    else window.location.assign(url(view, target.toISODate()!));
  };

  const hours = Array.from({ length: endHour - startHour }, (_, i) => startHour + i);
  const gridHeight = (endHour - startHour) * PPH;

  function Column({ day }: { day: DateTime }) {
    const items = byDay.get(day.toISODate()!) ?? [];
    const lane = lanes(items);
    const isToday = day.hasSame(now, "day");
    const nowTop = (now.hour + now.minute / 60 - startHour) * PPH;
    return (
      <div className="cb-col" style={{ height: gridHeight }}>
        {hours.map((h) => (
          <div key={h} className="cb-line" style={{ top: (h - startHour) * PPH }} />
        ))}
        {hours.map((h) => (
          <div key={`h${h}`} className="cb-line half" style={{ top: (h - startHour) * PPH + PPH / 2 }} />
        ))}
        {items.map((l) => {
          const s = dt(l.start);
          const e = dt(l.end);
          const top = (s.hour + s.minute / 60 - startHour) * PPH;
          const height = Math.max(26, e.diff(s, "minutes").minutes * (PPH / 60) - 3);
          const pos = lane.get(l.id) ?? { lane: 0, lanes: 1 };
          const width = 100 / pos.lanes;
          return (
            <button
              key={l.id}
              type="button"
              popoverTarget={`lp-${l.id}`}
              className={`cb-event ${l.status}`}
              style={{
                top,
                height,
                insetInlineStart: `calc(${pos.lane * width}% + 3px)`,
                width: `calc(${width}% - 6px)`,
                insetInlineEnd: "auto",
                ...(l.color ? { borderInlineStartColor: l.color } : {}),
              }}
              aria-label={`${s.toFormat("HH:mm")} ${l.student}, ${l.statusLabel}`}
            >
              <span className="t">
                {"⁦"}
                {s.toFormat("HH:mm")}–{e.toFormat("HH:mm")}
                {"⁩"}
              </span>
              <span className="s">{l.student}</span>
              {height > 50 && <span className="m">{l.instructor ?? l.levelLabel}</span>}
            </button>
          );
        })}
        {isToday && nowTop > 0 && nowTop < gridHeight && <div className="cb-now" style={{ top: nowTop }} />}
      </div>
    );
  }

  const weekDays = view === "month" ? [] : view === "week" ? days : Array.from({ length: 7 }, (_, i) => f.startOf("week").plus({ days: i }));

  return (
    <div className="cb" onTouchStart={onTouchStart} onTouchEnd={onTouchEnd}>
      <div className="cb-bar">
        <a className="btn cb-icon" href={url(view, prev.toISODate()!)} onClick={(e) => go(view, prev, e)} aria-label={labels.previous}>
          ‹
        </a>
        <a className="btn cb-icon" href={url(view, next.toISODate()!)} onClick={(e) => go(view, next, e)} aria-label={labels.next}>
          ›
        </a>
        <span className="title">{title}</span>
        <a className="btn sm" href={url(view, now.toISODate()!)} onClick={(e) => go(view, now, e)}>
          {labels.today}
        </a>
      </div>
      <div className="seg" role="tablist" style={{ justifySelf: "start" }}>
        {(["day", "week", "month"] as const).map((v) => (
          <a key={v} href={url(v, focus)} onClick={(e) => go(v, f, e)} aria-current={v === view ? "page" : undefined}>
            {labels[v]}
          </a>
        ))}
      </div>

      {view !== "month" && (
        <nav className={`cb-strip ${view === "week" ? "in-week" : ""}`} aria-label={labels.week}>
          {weekDays.map((d) => {
            const n = (byDay.get(d.toISODate()!) ?? []).filter((l) => l.status !== "cancelled").length;
            const selected = view === "day" ? d.hasSame(f, "day") : false;
            return (
              <a
                key={d.toISODate()}
                href={url("day", d.toISODate()!)}
                onClick={(e) => go("day", d, e)}
                className={d.hasSame(now, "day") ? "today" : undefined}
                aria-pressed={selected}
                aria-label={`${d.toFormat("cccc d LLLL")}: ${fill(labels.lessonsCount, n)}`}
              >
                <span className="w">{d.toFormat("ccc")}</span>
                <span className="d">{d.day}</span>
                <span className={`n ${n ? "" : "none"}`} />
              </a>
            );
          })}
        </nav>
      )}

      {view === "month" ? (
        <div className="cb-month">
          {days.slice(0, 7).map((d) => (
            <div key={`wd${d.weekday}`} className="wd">{d.toFormat("ccc")}</div>
          ))}
          {days.map((d) => {
            const items = (byDay.get(d.toISODate()!) ?? []).sort((a, b) => a.start.localeCompare(b.start));
            return (
              <a
                key={d.toISODate()}
                href={url("day", d.toISODate()!)}
                onClick={(e) => go("day", d, e)}
                className={`${d.month !== f.month ? "other" : ""} ${d.hasSame(now, "day") ? "today" : ""}`}
                aria-label={`${d.toFormat("cccc d LLLL")}: ${fill(labels.lessonsCount, items.length)}`}
              >
                <span className="dn">{d.day}</span>
                <span className="pips">
                  {items.slice(0, 8).map((l) => (
                    <span key={l.id} className={`pip ${l.status}`} />
                  ))}
                </span>
                {items.length > 0 && <span className="cnt">{items.length}</span>}
              </a>
            );
          })}
        </div>
      ) : (
        <div className="cb-scroll" ref={scroller}>
          {/* Week: 7 columns; on phones the grid scrolls sideways with the hours column pinned. */}
          <div className={`cb-grid ${view === "week" ? "cb-week" : ""}`} style={{ ["--cols" as string]: view === "week" ? 7 : 1 }}>
            <div className="cb-corner" />
            {(view === "week" ? days : [f]).map((d) => (
              <a
                key={`h${d.toISODate()}`}
                className={`cb-colhead ${d.hasSame(now, "day") ? "today" : ""}`}
                href={url("day", d.toISODate()!)}
                onClick={(e) => go("day", d, e)}
              >
                {d.toFormat("ccc")} <b>{d.day}</b>
              </a>
            ))}
            <div className="cb-hours" style={{ height: gridHeight }}>
              {hours.map((h) => (
                <span key={h} className="cb-hour" style={{ top: (h - startHour) * PPH }}>
                  {h > startHour ? `${String(h).padStart(2, "0")}:00` : ""}
                </span>
              ))}
            </div>
            {(view === "week" ? days : [f]).map((d) => (
              <Column key={d.toISODate()} day={d} />
            ))}
          </div>
          {(view === "week" ? days : [f]).every((d) => !(byDay.get(d.toISODate()!) ?? []).length) && <p className="cb-empty">{labels.noLessons}</p>}
        </div>
      )}

      {/* One pop-up per lesson in view. */}
      {lessons.map((l) => {
        const s = dt(l.start);
        const e = dt(l.end);
        return (
          <div key={`p${l.id}`} id={`lp-${l.id}`} popover="auto" className="sheet-pop">
            <div className="grab" />
            <div className="spread">
              <span className="eyebrow">{s.toFormat("cccc d LLLL")}</span>
              <span className={`badge ${l.statusTone}`}>{l.statusLabel}</span>
            </div>
            <p className="hero-time" style={{ fontSize: "1.7rem" }}>
              {"⁦"}
              {s.toFormat("HH:mm")}–{e.toFormat("HH:mm")}
              {"⁩"}
            </p>
            <p style={{ fontSize: "1.1rem", fontWeight: 700, margin: 0 }}>{l.student}</p>
            <p className="muted" style={{ margin: "2px 0 0" }}>
              {l.lessonLabel} · {l.levelLabel}
            </p>
            <p className="muted small" style={{ margin: "2px 0 0" }}>
              {l.vehicle}
              {l.instructor ? ` · ${l.instructor}` : ""}
            </p>
            <div className="actions">
              <a className="btn primary" href={`/lessons/${l.id}`}>{labels.openLesson}</a>
              {l.studentPhone ? <a className="btn" href={`tel:${l.studentPhone}`}>{labels.call}</a> : <span />}
              {l.canConfirm && (
                <form action={confirmAction}>
                  <input type="hidden" name="lessonId" value={l.id} />
                  <button type="submit">{labels.confirm}</button>
                </form>
              )}
              {l.canStart && (
                <form action={startAction}>
                  <input type="hidden" name="lessonId" value={l.id} />
                  <button type="submit" className="accent">{labels.start}</button>
                </form>
              )}
              {l.feedback !== "none" && (
                <a className="btn accent" href={`${props.feedbackBase}/${l.id}`}>
                  {l.feedback === "edit" ? labels.editFeedback : labels.giveFeedback}
                </a>
              )}
              <button type="button" className="ghost" popoverTarget={`lp-${l.id}`} popoverTargetAction="hide">
                {labels.close}
              </button>
            </div>
          </div>
        );
      })}
    </div>
  );
}
