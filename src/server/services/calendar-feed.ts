/**
 * Personal calendar link (iCalendar feed) so Google Calendar, Apple Calendar
 * or Outlook show a user's lessons and keep them up to date by themselves.
 *
 * The link is /api/calendar/<user id>/<token>.ics. The token is an HMAC of the
 * user id and users.calendar_feed_version, so no secret is stored in the
 * database. "New link" bumps the version (the old link stops working) and
 * "Turn off" sets it to NULL.
 *
 * What a feed shows: an instructor sees their own lessons; a student their own
 * lessons; an owner or office user without an instructor profile the whole
 * school. From 30 days back to 180 days ahead; cancelled lessons are left out.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { many, one, withPlatform, withTenant, type Tx } from "@/lib/db";
import { env } from "@/lib/env";
import { can, type Role } from "@/lib/rbac";
import { ForbiddenError } from "@/lib/errors";
import type { Principal } from "../principal";
import { audit } from "./audit";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function feedToken(userId: string, version: number): string {
  return createHmac("sha256", env.sessionSecret).update(`calendar-feed:${userId}:${version}`).digest("base64url").slice(0, 32);
}

export function feedUrl(userId: string, version: number): string {
  return `${env.appUrl}/api/calendar/${userId}/${feedToken(userId, version)}.ics`;
}

/** The signed-in user's current link, or null when they have none. */
export async function currentFeedUrl(tx: Tx, userId: string): Promise<string | null> {
  const r = await one<{ v: number | null }>(tx, `SELECT calendar_feed_version AS v FROM users WHERE id = $1`, [userId]);
  return r?.v ? feedUrl(userId, r.v) : null;
}

/** Create a link, or replace it with a new one (the old link stops working). */
export async function renewFeed(tx: Tx, p: Principal): Promise<string> {
  if (p.type !== "user") throw new ForbiddenError();
  const r = await one<{ v: number }>(
    tx,
    `UPDATE users SET calendar_feed_version = COALESCE(calendar_feed_version, 0) + 1 WHERE id = $1 RETURNING calendar_feed_version AS v`,
    [p.actor.userId],
  );
  await audit(tx, p, "calendar_feed.renewed", "user", p.actor.userId);
  return feedUrl(p.actor.userId, r!.v);
}

export async function disableFeed(tx: Tx, p: Principal) {
  if (p.type !== "user") throw new ForbiddenError();
  await tx.query(`UPDATE users SET calendar_feed_version = NULL WHERE id = $1`, [p.actor.userId]);
  await audit(tx, p, "calendar_feed.disabled", "user", p.actor.userId);
}

/** iCalendar text: escape \ ; , and newlines (RFC 5545 §3.3.11). */
export const icsEscape = (s: string) => s.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");
const stamp = (d: Date) => d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
/** Lines longer than 75 octets are folded (RFC 5545 §3.1). */
function fold(line: string): string {
  const out: string[] = [];
  let rest = Buffer.from(line, "utf8");
  while (rest.length > 75) {
    let cut = out.length ? 74 : 75;
    while (cut > 0 && (rest[cut]! & 0xc0) === 0x80) cut--; // never split a UTF-8 character
    out.push(rest.subarray(0, cut).toString("utf8"));
    rest = rest.subarray(cut);
  }
  out.push(rest.toString("utf8"));
  return out.join("\r\n ");
}

interface FeedLesson {
  id: string;
  start_time: Date;
  end_time: Date;
  status: string;
  lesson_number: number;
  student: string;
  instructor: string;
  vehicle: string | null;
  pickup_address: string | null;
  dropoff_address: string | null;
}

export function renderFeed(args: { calendarName: string; lessons: FeedLesson[]; view: "student" | "instructor" | "school"; labels: FeedLabels }): string {
  const { labels: L } = args;
  const now = stamp(new Date());
  const events = args.lessons.flatMap((l) => {
    const title =
      args.view === "student" ? `${L.lesson} ${l.lesson_number} · ${l.instructor}`
      : args.view === "instructor" ? `${l.student} · ${L.lesson} ${l.lesson_number}`
      : `${l.student} · ${l.instructor}`;
    const desc = [
      args.view !== "instructor" ? `${L.instructor}: ${l.instructor}` : null,
      args.view !== "student" ? `${L.student}: ${l.student}` : null,
      l.vehicle ? `${L.vehicle}: ${l.vehicle}` : null,
      l.dropoff_address && l.dropoff_address !== l.pickup_address ? `${L.endPoint}: ${l.dropoff_address}` : null,
    ].filter(Boolean).join("\n");
    return [
      "BEGIN:VEVENT",
      `UID:lesson-${l.id}@drivedesk`,
      `DTSTAMP:${now}`,
      `DTSTART:${stamp(l.start_time)}`,
      `DTEND:${stamp(l.end_time)}`,
      `SUMMARY:${icsEscape(title)}`,
      desc ? `DESCRIPTION:${icsEscape(desc)}` : null,
      l.pickup_address ? `LOCATION:${icsEscape(l.pickup_address)}` : null,
      `STATUS:${l.status === "scheduled" ? "TENTATIVE" : "CONFIRMED"}`,
      ...(l.start_time > new Date() ? ["BEGIN:VALARM", "TRIGGER:-PT1H", "ACTION:DISPLAY", `DESCRIPTION:${icsEscape(title)}`, "END:VALARM"] : []),
      "END:VEVENT",
    ].filter((x): x is string => x !== null);
  });
  return [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//DriveDesk//Lessons//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    `X-WR-CALNAME:${icsEscape(args.calendarName)}`,
    "X-PUBLISHED-TTL:PT1H",
    "REFRESH-INTERVAL;VALUE=DURATION:PT1H",
    ...events,
    "END:VCALENDAR",
    "",
  ].map(fold).join("\r\n");
}

export interface FeedLabels {
  lesson: string;
  instructor: string;
  student: string;
  vehicle: string;
  endPoint: string;
}

/**
 * Resolve a feed link to its calendar text, or null when the link is wrong,
 * turned off or replaced, or the account or school is no longer active.
 */
export async function loadFeed(userId: string, token: string, labelsFor: (locale: string) => Promise<FeedLabels>): Promise<string | null> {
  if (!UUID.test(userId) || !/^[A-Za-z0-9_-]{32}$/.test(token)) return null;
  const u = await withPlatform((tx) =>
    one<{ id: string; school_id: string | null; role: Role; status: string; v: number | null; locale: string | null; instructor_id: string | null; student_id: string | null; school: string; school_status: string }>(
      tx,
      `SELECT u.id, u.school_id, u.role, u.status, u.calendar_feed_version AS v, u.locale,
              i.id AS instructor_id, s.id AS student_id, sc.name AS school, sc.status AS school_status
         FROM users u JOIN schools sc ON sc.id = u.school_id
         LEFT JOIN instructors i ON i.user_id = u.id AND i.status = 'active'
         LEFT JOIN students s ON s.user_id = u.id
        WHERE u.id = $1`,
      [userId],
    ),
  );
  if (!u || !u.v || !u.school_id || u.status !== "active" || !["trial", "active"].includes(u.school_status)) return null;
  const expected = Buffer.from(feedToken(u.id, u.v));
  const given = Buffer.from(token);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;

  const view: "student" | "instructor" | "school" | null =
    u.role === "student" && u.student_id ? "student" : u.instructor_id ? "instructor" : can(u.role, "lessons:read_all") ? "school" : null;
  if (!view) return null;
  const lessons = await withTenant(u.school_id, (tx) =>
    many<FeedLesson>(
      tx,
      `SELECT l.id, l.start_time, l.end_time, l.status, l.lesson_number,
              s.first_name || ' ' || s.last_name AS student, i.first_name || ' ' || i.last_name AS instructor,
              CASE WHEN v.id IS NULL THEN NULL ELSE v.brand || ' ' || v.model END AS vehicle,
              l.pickup_address, l.dropoff_address
         FROM lessons l JOIN students s ON s.id = l.student_id JOIN instructors i ON i.id = l.instructor_id
         LEFT JOIN vehicles v ON v.id = l.vehicle_id
        WHERE l.status IN ('scheduled','confirmed','in_progress','completed')
          AND l.start_time >= now() - interval '30 days' AND l.start_time < now() + interval '180 days'
          AND ($1::uuid IS NULL OR l.student_id = $1) AND ($2::uuid IS NULL OR l.instructor_id = $2)
        ORDER BY l.start_time
        LIMIT 3000`,
      [view === "student" ? u.student_id : null, view === "instructor" ? u.instructor_id : null],
    ),
  );
  return renderFeed({ calendarName: u.school, lessons, view, labels: await labelsFor(u.locale ?? "en") });
}
