/** Texts for the shared date field; plain module so server components can build them. */
export type DateFieldLabels = { pickDay: string; chooseDate: string; prevMonth: string; nextMonth: string; today: string; close: string; year: string };

export function dateFieldLabels(t: (key: "common.pickDay" | "common.chooseDate" | "common.prevMonth" | "common.nextMonth" | "common.today" | "common.close" | "common.year") => string): DateFieldLabels {
  return { pickDay: t("common.pickDay"), chooseDate: t("common.chooseDate"), prevMonth: t("common.prevMonth"), nextMonth: t("common.nextMonth"), today: t("common.today"), close: t("common.close"), year: t("common.year") };
}
