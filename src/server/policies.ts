/**
 * Business rules that must be enforced on the server. Pure functions so they
 * are easy to test; services call them inside the transaction using the
 * database clock (SELECT now()) rather than the app server's clock.
 */
import { DateTime } from "luxon";

export type LessonStatus = "scheduled" | "confirmed" | "in_progress" | "completed" | "cancelled" | "no_show" | "rescheduled";

/**
 * Latest moment a change is still allowed, computed in the school's timezone.
 * Whole days of notice are subtracted as *calendar* days, so "24 hours before
 * a lesson at 15:00" is always 15:00 local the previous day, including across
 * a DST change (when that day is 23 or 25 real hours long). Remaining hours
 * are subtracted as elapsed time.
 */
export function noticeDeadline(lessonStart: Date, noticeHours: number, timezone: string): Date {
  const local = DateTime.fromJSDate(lessonStart, { zone: timezone });
  const days = Math.floor(noticeHours / 24);
  const hours = noticeHours % 24;
  return local.minus({ days }).minus({ hours }).toJSDate();
}

export type PolicyResult =
  | { allowed: true; deadline: Date }
  | { allowed: false; code: "notice_period_passed" | "lesson_not_changeable" | "lesson_in_past"; deadline: Date | null; message: string };

const CHANGEABLE: LessonStatus[] = ["scheduled", "confirmed"];

function check(
  action: "reschedule" | "cancel",
  args: { lessonStart: Date; status: LessonStatus; now: Date; noticeHours: number; timezone: string },
): PolicyResult {
  if (!CHANGEABLE.includes(args.status)) {
    return { allowed: false, code: "lesson_not_changeable", deadline: null, message: `A ${args.status.replace("_", " ")} lesson cannot be changed.` };
  }
  if (args.lessonStart.getTime() <= args.now.getTime()) {
    return { allowed: false, code: "lesson_in_past", deadline: null, message: "This lesson has already started." };
  }
  const deadline = noticeDeadline(args.lessonStart, args.noticeHours, args.timezone);
  if (args.now.getTime() > deadline.getTime()) {
    const when = DateTime.fromJSDate(deadline, { zone: args.timezone }).toFormat("ccc d LLL, HH:mm");
    return {
      allowed: false,
      code: "notice_period_passed",
      deadline,
      message: `Lessons can only be ${action === "reschedule" ? "rescheduled" : "cancelled"} online up to ${args.noticeHours} hours in advance (deadline was ${when}). Please contact the school.`,
    };
  }
  return { allowed: true, deadline };
}

/** Student self-service reschedule rule (default 24h, configurable per school). */
export function checkStudentReschedule(args: { lessonStart: Date; status: LessonStatus; now: Date; noticeHours: number; timezone: string }) {
  return check("reschedule", args);
}

/** Student self-service cancellation rule. Late cancellation is allowed only by staff (and may incur a fee). */
export function checkStudentCancellation(args: { lessonStart: Date; status: LessonStatus; now: Date; noticeHours: number; timezone: string }) {
  return check("cancel", args);
}

/** Whether a staff cancellation should add the school's late-cancellation fee. */
export function isLateCancellation(args: { lessonStart: Date; now: Date; noticeHours: number; timezone: string }): boolean {
  return args.now.getTime() > noticeDeadline(args.lessonStart, args.noticeHours, args.timezone).getTime();
}
