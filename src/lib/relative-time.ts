import { DateTime } from "luxon";

/**
 * "in 25 minutes", "in 3 hours", "tomorrow", "in 4 days" — the countdown
 * shown on lesson cards. Same calendar day (in the school's time zone) counts
 * in minutes/hours; anything later counts in days, so a lesson tomorrow
 * morning reads "tomorrow" rather than "in 15 hours".
 */
export function relativeWhen(target: Date, now: Date, tag: string, zone: string): string {
  const rtf = new Intl.RelativeTimeFormat(tag, { numeric: "auto" });
  const a = DateTime.fromJSDate(now, { zone });
  const b = DateTime.fromJSDate(target, { zone });
  const days = Math.round(b.startOf("day").diff(a.startOf("day"), "days").days);
  if (days !== 0) return rtf.format(days, "day");
  const minutes = Math.round((target.getTime() - now.getTime()) / 60000);
  if (minutes === 0) return rtf.format(0, "second"); // "now"
  if (Math.abs(minutes) < 60) return rtf.format(minutes, "minute");
  return rtf.format(Math.round(minutes / 60), "hour");
}

/** "morning" | "afternoon" | "evening" for the greeting, by the hour in the school's time zone. */
export function partOfDay(now: Date, zone: string): "morning" | "afternoon" | "evening" {
  const h = DateTime.fromJSDate(now, { zone }).hour;
  return h < 12 ? "morning" : h < 18 ? "afternoon" : "evening";
}
