/** "Reschedule" button that opens the week-table picker in a pop-up (native popover). */
import type { Translate } from "@/i18n";
import { ReschedulePicker, type PickerLabels } from "./reschedule-picker";

export function pickerLabels(t: Translate): PickerLabels {
  const p = (k: string) => t(`student.picker.${k}` as Parameters<Translate>[0]);
  return {
    title: t("student.picker.title", { number: "{number}" }),
    current: p("current"), pick: p("pick"), free: p("free"), taken: p("taken"), yours: p("yours"),
    prevWeek: p("prevWeek"), nextWeek: p("nextWeek"), loading: p("loading"), noneThisWeek: p("noneThisWeek"),
    newTime: p("newTime"), approvalNote: p("approvalNote"), confirm: p("confirm"), confirmRequest: p("confirmRequest"),
    taken409: p("taken409"), time: p("time"), reason: t("common.reason"), optional: t("common.optional"), close: t("common.close"),
  };
}

export function RescheduleButton({ lessonId, t, primary = false }: { lessonId: string; t: Translate; primary?: boolean }) {
  const id = `resched-${lessonId}`;
  return (
    <>
      <button type="button" className={primary ? "btn primary" : "btn"} popoverTarget={id}>{t("student.reschedule")}</button>
      <div id={id} popover="auto" className="sheet-pop rp-pop">
        <div className="grab" aria-hidden />
        <ReschedulePicker lessonId={lessonId} labels={pickerLabels(t)} popoverId={id} />
      </div>
    </>
  );
}
