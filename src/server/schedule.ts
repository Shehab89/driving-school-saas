import "server-only";
import { DateTime } from "luxon";
import { withTenant } from "@/lib/db";
import { can, type SchoolActor } from "@/lib/rbac";
import type { Formatter, Translate } from "@/i18n";
import { STATUS_TONE } from "@/components/ui";
import type { BoardLesson, BoardView } from "@/components/schedule-board";
import { listCalendarLessons } from "./services/lessons";

/**
 * Loads a whole month (full weeks) around the anchor date so the board can
 * switch day / week / month and move within the month without a round trip.
 */
export async function loadBoard(args: {
  actor: SchoolActor;
  zone: string;
  t: Translate;
  f: Formatter;
  view: string | undefined;
  date: string | undefined;
  instructorId: string | null;
  basePath: string;
  extraQuery?: string;
  showInstructor: boolean;
}) {
  const { actor, zone, t, f } = args;
  const view: BoardView = args.view === "day" || args.view === "month" ? args.view : args.view === "week" ? "week" : "week";
  const parsed = args.date ? DateTime.fromISO(args.date, { zone }) : DateTime.now().setZone(zone);
  const anchor = parsed.isValid ? parsed : DateTime.now().setZone(zone);
  const rangeStart = anchor.startOf("month").startOf("week");
  const rangeEnd = anchor.endOf("month").endOf("week").plus({ days: 1 }).startOf("day");
  const rows = await withTenant(actor.schoolId, (tx) =>
    listCalendarLessons(tx, { from: rangeStart.toJSDate(), to: rangeEnd.toJSDate(), instructorId: args.instructorId }),
  );
  const now = Date.now();
  const staff = can(actor.role, "lessons:write_all");
  const lessons: BoardLesson[] = rows.map((l) => {
    const own = staff || l.instructor_id === actor.instructorId;
    const start = new Date(l.start_time).getTime();
    const end = new Date(l.end_time).getTime();
    return {
      id: l.id,
      start: new Date(l.start_time).toISOString(),
      end: new Date(l.end_time).toISOString(),
      status: l.status,
      statusLabel: t(`status.${l.status}` as Parameters<Translate>[0]),
      statusTone: STATUS_TONE[l.status] ?? "",
      student: l.student_name,
      studentPhone: l.student_phone,
      lessonLabel: t("common.lessonNo", { number: l.lesson_number }),
      levelLabel: l.level_position ? t("common.level", { position: l.level_position }) : t("common.levelNotSet"),
      vehicle: l.vehicle ? `${l.vehicle}${l.registration_number ? ` (${l.registration_number})` : ""}` : t("common.noVehicle"),
      instructor: args.showInstructor ? l.instructor_name : null,
      color: args.showInstructor ? l.instructor_color : null,
      canConfirm: own && l.status === "scheduled" && start > now,
      canStart: own && ["scheduled", "confirmed"].includes(l.status) && now >= start - 30 * 60_000 && now < end,
      feedback: own && ["completed", "in_progress"].includes(l.status) ? (l.has_feedback ? "edit" : "give") : "none",
    };
  });
  return {
    lessons,
    zone,
    tag: f.tag,
    view,
    focus: anchor.toISODate()!,
    rangeStart: rangeStart.toISODate()!,
    rangeEnd: rangeEnd.toISODate()!,
    basePath: args.basePath,
    extraQuery: args.extraQuery,
    feedbackBase: "/instructor/feedback",
    labels: {
      today: t("common.today"),
      day: t("instructor.calendar.day"),
      week: t("instructor.calendar.week"),
      month: t("instructor.calendar.month"),
      previous: t("common.previous"),
      next: t("common.next"),
      noLessons: t("instructor.calendar.noLessons"),
      openLesson: t("instructor.openLesson"),
      call: t("instructor.call"),
      confirm: t("instructor.lesson.confirm"),
      start: t("instructor.lesson.start"),
      giveFeedback: t("instructor.feedback.give"),
      editFeedback: t("instructor.feedback.edit"),
      close: t("common.close"),
      lessonsCount: t("instructor.calendar.lessonsCount", { count: "{count}" }),
    },
  };
}
