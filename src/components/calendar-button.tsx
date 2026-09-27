/**
 * Book / Reschedule entry points. The button opens the calendar in a pop-up
 * (native popover); the first week is rendered on the server.
 */
import type { Translate } from "@/i18n";
import type { SchoolActor } from "@/lib/rbac";
import { loadCalendarData } from "@/server/slot-calendar";
import { SlotCalendar, type CalLabels } from "./slot-calendar";

export function calendarLabels(t: Translate, price: string | null = null): CalLabels {
  return {
    pick: t("student.picker.pick"), free: t("student.picker.free"), taken: t("student.picker.taken"), current: t("student.picker.current"),
    yours: t("student.picker.yours"), prevWeek: t("student.picker.prevWeek"), nextWeek: t("student.picker.nextWeek"),
    noneThisWeek: t("student.picker.noneThisWeek"), newTime: t("student.picker.newTime"), approvalNote: t("student.picker.approvalNote"),
    confirm: t("student.picker.confirm"), confirmRequest: t("student.picker.confirmRequest"), confirmBook: t("student.bookThis"),
    taken409: t("student.picker.taken409"), reason: t("common.reason"), optional: t("common.optional"), close: t("common.close"), price,
  };
}

/** lessonId = null opens the booking calendar for a new lesson. */
export async function CalendarButton({
  actor, t, lessonId, label, primary = false, price = null, block = false,
}: { actor: SchoolActor; t: Translate; lessonId: string | null; label: string; primary?: boolean; price?: string | null; block?: boolean }) {
  const data = await loadCalendarData(actor, lessonId);
  const id = `cal-${lessonId ?? "book"}`;
  return (
    <>
      <button type="button" className={`btn${primary ? " primary" : ""}${block ? " block" : ""}`} popoverTarget={id}>{label}</button>
      <div id={id} popover="auto" className="sheet-pop scal-pop">
        <div className="grab" aria-hidden />
        <SlotCalendar initial={data} labels={calendarLabels(t, price)} popoverId={id} />
      </div>
    </>
  );
}

/** The same calendar inline on a page (Book tab, reschedule deep link). */
export async function CalendarPanel({ actor, t, lessonId, price = null }: { actor: SchoolActor; t: Translate; lessonId: string | null; price?: string | null }) {
  const data = await loadCalendarData(actor, lessonId);
  return <SlotCalendar initial={data} labels={calendarLabels(t, price)} />;
}
