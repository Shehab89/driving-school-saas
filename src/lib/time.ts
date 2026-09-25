import { DateTime } from "luxon";

export function isValidTimezone(tz: string): boolean {
  return DateTime.local().setZone(tz).isValid;
}

/** "HH:MM" or "HH:MM:SS" on a local ISO date in a zone -> epoch ms. */
export function localToMillis(isoDate: string, time: string, zone: string): number {
  const dt = DateTime.fromISO(`${isoDate}T${time.length === 5 ? time + ":00" : time}`, { zone });
  if (!dt.isValid) throw new Error(`Invalid local time ${isoDate} ${time} in ${zone}`);
  return dt.toMillis();
}

export function formatDate(d: Date | string, zone: string, locale = "en"): string {
  return DateTime.fromJSDate(new Date(d), { zone }).setLocale(locale).toFormat("cccc d LLLL yyyy");
}
export function formatShortDate(d: Date | string, zone: string, locale = "en"): string {
  return DateTime.fromJSDate(new Date(d), { zone }).setLocale(locale).toFormat("ccc d LLL");
}
export function formatTime(d: Date | string, zone: string): string {
  return DateTime.fromJSDate(new Date(d), { zone }).toFormat("HH:mm");
}
export function formatTimeRange(start: Date | string, end: Date | string, zone: string): string {
  return `${formatTime(start, zone)}–${formatTime(end, zone)}`;
}
export function formatDateTime(d: Date | string, zone: string, locale = "en"): string {
  return `${formatShortDate(d, zone, locale)} ${formatTime(d, zone)}`;
}

export function formatMoney(cents: number, currency: string, locale = "en"): string {
  return new Intl.NumberFormat(locale, { style: "currency", currency }).format(cents / 100);
}

export function durationMinutes(start: Date | string, end: Date | string): number {
  return Math.round((new Date(end).getTime() - new Date(start).getTime()) / 60000);
}

/** Today's date (YYYY-MM-DD) in a zone. */
export function todayIn(zone: string, now: Date = new Date()): string {
  return DateTime.fromJSDate(now, { zone }).toISODate()!;
}
