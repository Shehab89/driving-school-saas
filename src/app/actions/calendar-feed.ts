"use server";
import { withTenant } from "@/lib/db";
import { getI18n } from "@/i18n/server";
import { requireSchoolActor } from "@/server/auth/session";
import { userPrincipal } from "@/server/principal";
import { disableFeed, renewFeed } from "@/server/services/calendar-feed";
import { runAction } from "@/server/web";

/** Pages that show the calendar-link card; the action goes back to the one it came from. */
const BACK = new Set(["/student/profile", "/instructor/profile", "/instructor/more", "/account"]);

export async function calendarFeedAction(fd: FormData) {
  const { t } = await getI18n();
  const back = String(fd.get("back") ?? "");
  const op = String(fd.get("op") ?? "");
  const renewing = fd.get("had") === "1";
  await runAction(
    async () => {
      const actor = await requireSchoolActor();
      await withTenant(actor.schoolId, async (tx) => {
        if (op === "off") await disableFeed(tx, userPrincipal(actor));
        else await renewFeed(tx, userPrincipal(actor));
      });
    },
    {
      back: BACK.has(back) ? back : "/account",
      okMessage: t(op === "off" ? "common.calendarSync.offOk" : renewing ? "common.calendarSync.renewedOk" : "common.calendarSync.onOk"),
    },
  );
}
