import { Flash, sp, type SearchParams } from "@/components/ui";
import { CalendarPanel } from "@/components/calendar-button";
import { withTenant } from "@/lib/db";
import { getI18n } from "@/i18n/server";
import { requireSchoolActor } from "@/server/auth/session";
import { userPrincipal } from "@/server/principal";
import { setEarlierSlotAlert } from "@/server/services/slot-alerts";
import { runAction } from "@/server/web";
import { loadStudent } from "../data";

async function toggleSlotAlert(fd: FormData) {
  "use server";
  const { t } = await getI18n();
  const on = fd.get("on") === "1";
  await runAction(
    async () => {
      const actor = await requireSchoolActor("profile:write_own");
      await withTenant(actor.schoolId, (tx) => setEarlierSlotAlert(tx, userPrincipal(actor), actor.studentId!, on));
    },
    { back: "/student/book", okMessage: t(on ? "student.slotAlertSaved" : "student.slotAlertStopped") },
  );
}

/** Book tab: the booking calendar (free periods in green, busy time in grey) and the "earlier time" alert. */
export default async function BookPage({ searchParams }: { searchParams: SearchParams }) {
  const q = await sp(searchParams);
  const { actor, d, t, f } = await loadStudent();
  if (!d.booking.selfBooking) {
    return (<><h1>{t("student.bookTitle")}</h1><div className="card"><p>{t("student.bookingOff")}</p></div></>);
  }
  const price = t("student.bookIntro", {
    transmission: d.student.preferred_transmission === "automatic" ? t("student.automatic").toLowerCase() : t("student.manual").toLowerCase(),
    minutes: d.booking.minutes,
    price: f.money(d.booking.priceCents, d.currency),
  });
  const alertOn = d.student.earlier_slot_alert;
  return (
    <>
      <Flash searchParams={q} />
      <section className="card">
        <CalendarPanel actor={actor} t={t} lessonId={null} price={price} />
      </section>
      <section className={`card slot-alert${alertOn ? " on" : ""}`} aria-labelledby="slot-alert-h" data-testid="slot-alert">
        <span className="slot-alert-icon" aria-hidden="true">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" /><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" /></svg>
        </span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <h2 id="slot-alert-h" style={{ margin: 0, fontSize: "1rem" }}>{t("student.slotAlertTitle")}</h2>
          <p className="sub" style={{ margin: "4px 0 10px" }}>{alertOn ? t("student.slotAlertActive") : t("student.slotAlertBody")}</p>
          <form action={toggleSlotAlert}>
            <input type="hidden" name="on" value={alertOn ? "0" : "1"} />
            <button className={alertOn ? "btn sm" : "btn primary sm"}>{alertOn ? t("student.slotAlertOff") : t("student.slotAlertOn")}</button>
          </form>
        </div>
      </section>
    </>
  );
}
