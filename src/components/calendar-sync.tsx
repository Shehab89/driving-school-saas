import { calendarFeedAction } from "@/app/actions/calendar-feed";
import type { Translate } from "@/i18n";
import { CopyButton } from "./copy-button";

/** "Lessons in your own calendar": make, copy, renew or turn off the personal calendar link. */
export function CalendarSyncCard({ url, back, t }: { url: string | null; back: string; t: Translate }) {
  return (
    <section className="card" aria-labelledby="cal-sync-h" data-testid="calendar-sync">
      <h2 id="cal-sync-h" style={{ marginTop: 0 }}>{t("common.calendarSync.title")}</h2>
      <p className="sub" style={{ marginTop: 0 }}>{t("common.calendarSync.intro")}</p>
      {url ? (
        <>
          <div className="feed-url">
            <input readOnly value={url} aria-label={t("common.calendarSync.title")} data-testid="calendar-feed-url" />
            <CopyButton text={url} label={t("common.calendarSync.copy")} done={t("common.calendarSync.copied")} />
          </div>
          <p className="sub" style={{ fontSize: "0.85rem" }}>{t("common.calendarSync.how")}</p>
          <p className="sub" style={{ fontSize: "0.85rem" }}>{t("common.calendarSync.private")}</p>
          <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
            <a className="btn sm" href={url.replace(/^https?:/, "webcal:")}>{t("common.calendarSync.openApple")}</a>
            <form action={calendarFeedAction}>
              <input type="hidden" name="back" value={back} />
              <input type="hidden" name="had" value="1" />
              <button className="btn sm">{t("common.calendarSync.renew")}</button>
            </form>
            <form action={calendarFeedAction}>
              <input type="hidden" name="back" value={back} />
              <input type="hidden" name="op" value="off" />
              <button className="btn sm ghost">{t("common.calendarSync.off")}</button>
            </form>
          </div>
        </>
      ) : (
        <form action={calendarFeedAction}>
          <input type="hidden" name="back" value={back} />
          <button className="btn primary sm">{t("common.calendarSync.turnOn")}</button>
        </form>
      )}
    </section>
  );
}
