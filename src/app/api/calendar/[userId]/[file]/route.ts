import { isLocale, translator } from "@/i18n";
import { loadFeed } from "@/server/services/calendar-feed";

/**
 * GET /api/calendar/<user id>/<token>.ics — a personal calendar feed that
 * Google Calendar, Apple Calendar and Outlook subscribe to. No session: the
 * signed token in the link is the key (see src/server/services/calendar-feed.ts).
 */
export async function GET(_req: Request, { params }: { params: Promise<{ userId: string; file: string }> }) {
  const { userId, file } = await params;
  const token = file.endsWith(".ics") ? file.slice(0, -4) : file;
  const body = await loadFeed(userId, token, async (locale) => {
    const t = translator(isLocale(locale) ? locale : "en");
    return {
      lesson: t("common.lesson"),
      instructor: t("common.instructor"),
      student: t("common.student"),
      vehicle: t("common.vehicle"),
      endPoint: t("common.calendarSync.endPoint"),
    };
  });
  if (body === null) return new Response("Not found", { status: 404, headers: { "Cache-Control": "no-store" } });
  return new Response(body, {
    headers: {
      "Content-Type": "text/calendar; charset=utf-8",
      "Content-Disposition": `inline; filename="lessons.ics"`,
      "Cache-Control": "private, max-age=300",
      "X-Robots-Tag": "noindex",
    },
  });
}
