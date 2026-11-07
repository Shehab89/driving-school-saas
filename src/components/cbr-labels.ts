import type { PortalTranslate } from "@/i18n/portal";
import type { CbrHealth, CbrProduct, CbrStatus } from "@/lib/cbr";

/** School-portal names of CBR products, statuses and health-declaration states. */
export function cbrLabels(pt: PortalTranslate) {
  const product: Record<CbrProduct, string> = {
    theory: pt("Theory exam"),
    interim_test: pt("Interim test (TTT)"),
    practical: pt("Practical exam B"),
    practical_anxiety: pt("Practical exam B (fear of failure)"),
    practical_be: pt("Practical exam BE (trailer)"),
  };
  const status: Record<CbrStatus, string> = {
    to_reserve: pt("Still to reserve"),
    reserved: pt("Reserved"),
    passed: pt("Passed"),
    failed: pt("Not passed"),
    cancelled: pt("Cancelled"),
    no_show: pt("Did not show up"),
  };
  const health: Record<CbrHealth, string> = {
    unknown: pt("Not done yet"),
    submitted: pt("Submitted, waiting for CBR"),
    approved: pt("Approved"),
    rejected: pt("Not approved (doctor needed)"),
  };
  return { product, status, health };
}

/** Badge tone for a CBR status (see STATUS_TONE). */
export const cbrTone = (s: CbrStatus) =>
  s === "passed" ? "completed" : s === "failed" || s === "no_show" ? "overdue" : s === "reserved" ? "scheduled" : s === "to_reserve" ? "pending" : "rescheduled";
