import Link from "next/link";
import { DateTime } from "luxon";
import type { CalendarLesson } from "@/server/services/lessons";
import type { Formatter, Translate } from "@/i18n";
import { StatusBadge } from "./ui";

export type CalendarView = "day" | "week" | "month";

export function LessonCard({ l, t, f }: { l: CalendarLesson; t: Translate; f: Formatter }) {
  return (
    <Link href={`/lessons/${l.id}`} className={`lesson ${l.status}`} style={l.instructor_color ? { borderInlineStartColor: l.instructor_color } : undefined}>
      <div className="spread">
        <span className="time num">{f.range(l.start_time, l.end_time)}</span>
        <StatusBadge value={l.status} t={t} />
      </div>
      <div><strong>{l.student_name}</strong> · {t("common.lessonNo", { number: l.lesson_number })}</div>
      <div className="small muted">
        {l.level_position ? t("common.level", { position: l.level_position }) : t("common.levelNotSet")} · {l.vehicle ?? t("common.noVehicle")}
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
  basePath,
  extraQuery = "",
  t,
  f,
}: {
  lessons: CalendarLesson[];
  view: CalendarView;
  anchor: DateTime;
  start: DateTime;
  end: DateTime;
  basePath: string;
  extraQuery?: string;
  t: Translate;
  f: Formatter;
}) {
  const loc = (d: DateTime) => d.setLocale(f.tag);
  const step = view === "day" ? { days: 1 } : view === "week" ? { weeks: 1 } : { months: 1 };
  const href = (v: CalendarView, d: DateTime) => `${basePath}?view=${v}&date=${d.toISODate()}${extraQuery}`;
  const title =
    view === "day"
      ? loc(anchor).toFormat("cccc d LLLL")
      : view === "week"
        ? `${loc(start).toFormat("d LLL")} – ${loc(end.minus({ days: 1 })).toFormat("d LLL yyyy")}`
        : loc(anchor).toFormat("LLLL yyyy");

  const days: DateTime[] = [];
  for (let d = start; d < end; d = d.plus({ days: 1 })) days.push(d);
  const zone = anchor.zoneName ?? undefined;
  const lessonsOn = (d: DateTime) => lessons.filter((l) => DateTime.fromJSDate(new Date(l.start_time), { zone }).hasSame(d, "day"));

  return (
    <>
      <div className="cal-toolbar">
        <Link className="btn" href={href(view, anchor.minus(step))} aria-label={t("common.previous")}>‹</Link>
        <Link className="btn" href={href(view, DateTime.now().setZone(zone))}>{t("common.today")}</Link>
        <Link className="btn" href={href(view, anchor.plus(step))} aria-label={t("common.next")}>›</Link>
        <strong style={{ marginInlineEnd: "auto" }}>{title}</strong>
        <div className="seg">
          {(["day", "week", "month"] as const).map((v) => (
            <Link key={v} className={v === view ? "active" : ""} href={href(v, anchor)} aria-current={v === view ? "page" : undefined}>
              {t(`instructor.calendar.${v}`)}
            </Link>
          ))}
        </div>
      </div>

      {view === "month" ? (
        <div className="month">
          {[1, 2, 3, 4, 5, 6, 7].map((d) => (
            <div key={d} className="small muted" style={{ textAlign: "center" }}>{f.weekdayShort(d)}</div>
          ))}
          {days.map((d) => {
            const list = lessonsOn(d).filter((l) => l.status !== "cancelled");
            return (
              <Link key={d.toISODate()} href={href("day", d)} className={`cell ${d.month !== anchor.month ? "other" : ""}`}>
                <span className="n">{d.day}</span>
                {list.slice(0, 3).map((l) => (
                  <span key={l.id} className="dot num">{f.time(l.start_time)} {l.student_name.split(" ")[0]}</span>
                ))}
                {list.length > 3 && <span className="dot muted">{t("common.more", { count: list.length - 3 })}</span>}
              </Link>
            );
          })}
        </div>
      ) : (
        days.map((d) => {
          const list = lessonsOn(d);
          return (
            <div key={d.toISODate()} className="cal-day">
              <h3>{loc(d).toFormat(view === "week" ? "ccc d LLL" : "cccc d LLL")}</h3>
              {list.length === 0 ? <p className="muted small">{t("instructor.calendar.noLessons")}</p> : list.map((l) => <LessonCard key={l.id} l={l} t={t} f={f} />)}
            </div>
          );
        })
      )}
    </>
  );
}
