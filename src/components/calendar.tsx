import Link from "next/link";
import { DateTime } from "luxon";
import type { CalendarLesson } from "@/server/services/lessons";
import { formatTimeRange } from "@/lib/time";
import { Badge } from "./ui";

export type CalendarView = "day" | "week" | "month";

function LessonCard({ l, tz }: { l: CalendarLesson; tz: string }) {
  return (
    <Link href={`/lessons/${l.id}`} className={`lesson ${l.status}`} style={l.instructor_color ? { borderLeftColor: l.instructor_color } : undefined}>
      <div className="spread">
        <span className="time">{formatTimeRange(l.start_time, l.end_time, tz)}</span>
        <Badge value={l.status} />
      </div>
      <div><strong>{l.student_name}</strong> · Lesson #{l.lesson_number}</div>
      <div className="small muted">
        {l.level_position ? `Level ${l.level_position}` : "Level not set"} · {l.vehicle ?? "no vehicle"}
        {l.registration_number ? ` (${l.registration_number})` : ""}
      </div>
    </Link>
  );
}

export function Calendar({
  lessons,
  view,
  anchor,
  start,
  end,
  tz,
  basePath,
  extraQuery = "",
}: {
  lessons: CalendarLesson[];
  view: CalendarView;
  anchor: DateTime;
  start: DateTime;
  end: DateTime;
  tz: string;
  basePath: string;
  extraQuery?: string;
}) {
  const step = view === "day" ? { days: 1 } : view === "week" ? { weeks: 1 } : { months: 1 };
  const href = (v: CalendarView, d: DateTime) => `${basePath}?view=${v}&date=${d.toISODate()}${extraQuery}`;
  const title =
    view === "day" ? anchor.toFormat("cccc d LLLL") : view === "week" ? `${start.toFormat("d LLL")} – ${end.minus({ days: 1 }).toFormat("d LLL yyyy")}` : anchor.toFormat("LLLL yyyy");

  const days: DateTime[] = [];
  for (let d = start; d < end; d = d.plus({ days: 1 })) days.push(d);
  const lessonsOn = (d: DateTime) =>
    lessons.filter((l) => DateTime.fromJSDate(new Date(l.start_time), { zone: tz }).hasSame(d, "day"));

  return (
    <>
      <div className="cal-toolbar">
        <Link className="btn" href={href(view, anchor.minus(step))} aria-label="Previous">‹</Link>
        <Link className="btn" href={href(view, DateTime.now().setZone(tz))}>Today</Link>
        <Link className="btn" href={href(view, anchor.plus(step))} aria-label="Next">›</Link>
        <strong style={{ marginRight: "auto" }}>{title}</strong>
        <div className="seg" role="tablist">
          {(["day", "week", "month"] as const).map((v) => (
            <Link key={v} className={v === view ? "active" : ""} href={href(v, anchor)} aria-current={v === view ? "page" : undefined}>
              {v[0]!.toUpperCase() + v.slice(1)}
            </Link>
          ))}
        </div>
      </div>

      {view === "month" ? (
        <div className="month">
          {["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((d) => (
            <div key={d} className="small muted" style={{ textAlign: "center" }}>{d}</div>
          ))}
          {days.map((d) => {
            const list = lessonsOn(d).filter((l) => !["cancelled"].includes(l.status));
            return (
              <Link key={d.toISODate()} href={href("day", d)} className={`cell ${d.month !== anchor.month ? "other" : ""}`}>
                <span className="n">{d.day}</span>
                {list.slice(0, 3).map((l) => (
                  <span key={l.id} className="dot">{DateTime.fromJSDate(new Date(l.start_time), { zone: tz }).toFormat("HH:mm")} {l.student_name.split(" ")[0]}</span>
                ))}
                {list.length > 3 && <span className="dot muted">+{list.length - 3} more</span>}
              </Link>
            );
          })}
        </div>
      ) : (
        days.map((d) => {
          const list = lessonsOn(d);
          if (view === "week" && list.length === 0) {
            return (
              <div key={d.toISODate()} className="cal-day">
                <h3>{d.toFormat("ccc d LLL")}</h3>
                <p className="muted small">No lessons</p>
              </div>
            );
          }
          return (
            <div key={d.toISODate()} className="cal-day">
              <h3>{d.toFormat("cccc d LLL")}</h3>
              {list.length === 0 ? <p className="muted">No lessons</p> : list.map((l) => <LessonCard key={l.id} l={l} tz={tz} />)}
            </div>
          );
        })
      )}
    </>
  );
}
