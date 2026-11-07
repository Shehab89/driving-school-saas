/**
 * CBR (Centraal Bureau Rijvaardigheidsbewijzen) rules DriveDesk checks before
 * and around an exam. Pure functions so they can be unit-tested; the school
 * still reserves exams in CBR's own portal.
 *
 * Sources (checked 2026-11): CBR reservation rules from 1 May 2024 (theory
 * certificate needed before reserving a practical exam; free cancellation up
 * to 4 weeks before), CBR 2026 fees for category B.
 */

export const CBR_PRODUCTS = ["theory", "interim_test", "practical", "practical_anxiety", "practical_be"] as const;
export type CbrProduct = (typeof CBR_PRODUCTS)[number];

export const CBR_STATUSES = ["to_reserve", "reserved", "passed", "failed", "cancelled", "no_show"] as const;
export type CbrStatus = (typeof CBR_STATUSES)[number];

export const CBR_HEALTH = ["unknown", "submitted", "approved", "rejected"] as const;
export type CbrHealth = (typeof CBR_HEALTH)[number];

/** CBR's 2026 fee per product (cents), a default the school can change. Theory: the student usually books and pays it. */
export const CBR_FEES_2026: Record<CbrProduct, number | null> = {
  theory: null,
  interim_test: 14350,
  practical: 14350,
  practical_anxiety: 20200,
  practical_be: 14350,
};

/** Usual length of the exam-day booking (car + instructor), in minutes: pick-up, warm-up drive and the exam itself. */
export const CBR_EXAM_DAY_MINUTES: Record<CbrProduct, number> = {
  theory: 0,
  interim_test: 120,
  practical: 120,
  practical_anxiety: 150,
  practical_be: 120,
};

/** A theory certificate is valid for 18 months after passing. */
export const THEORY_VALID_MONTHS = 18;
/** Cancelling (or moving) is possible until 4 weeks before the exam. */
export const CANCEL_UNTIL_DAYS = 28;

export const CBR_LINKS = {
  /** Students: health declaration (gezondheidsverklaring), authorise the school (machtiging), theory exam. */
  mijnCbr: "https://mijn.cbr.nl",
  /** Schools: reserve exams, results (TOP; from 1 April 2027 the Opleidersportaal with eHerkenning EH3). */
  schoolPortal: "https://top.cbr.nl",
  /** Public page with the exam rules for driving schools. */
  rulesForSchools: "https://www.cbr.nl/nl/voor-rijscholen/examenreservering",
};

export const isPractical = (p: CbrProduct) => p === "practical" || p === "practical_anxiety" || p === "practical_be";
/** Products the school reserves for the student (needs the student's authorisation in Mijn CBR). */
export const reservedBySchool = (p: CbrProduct) => p !== "theory";

const DAY = 86_400_000;

/** The day (yyyy-mm-dd) a theory certificate stops being valid. */
export function theoryValidUntil(passedOn: string): string {
  const [y, m, d] = passedOn.split("-").map(Number) as [number, number, number];
  const total = m - 1 + THEORY_VALID_MONTHS;
  const ty = y + Math.floor(total / 12);
  const tm = (total % 12) + 1;
  const last = new Date(Date.UTC(ty, tm, 0)).getUTCDate();
  return `${ty}-${String(tm).padStart(2, "0")}-${String(Math.min(d, last)).padStart(2, "0")}`;
}

/** Last day the exam can still be cancelled or moved without it counting as a late cancellation. */
export function cancelDeadline(examAt: Date): Date {
  return new Date(examAt.getTime() - CANCEL_UNTIL_DAYS * DAY);
}

export interface CbrStudentState {
  theoryPassedOn: string | null;
  health: CbrHealth;
  authorizedOn: string | null;
}

export type CbrCheckKey = "theory" | "health" | "authorization";
export interface CbrCheck { key: CbrCheckKey; done: boolean; /** Blocks reserving (or taking) this exam. */ blocking: boolean; detail?: { until?: string; expired?: boolean } }

/**
 * The student's CBR checklist for a product: what is done, what is still
 * needed and whether it blocks the reservation.
 * - authorisation (machtiging): needed for anything the school reserves
 * - theory certificate: needed before a practical exam can be reserved, and valid on the day you reserve
 * - health declaration: must be approved before the practical exam / interim test
 */
export function cbrChecklist(s: CbrStudentState, product: CbrProduct = "practical", today: string = new Date().toISOString().slice(0, 10)): CbrCheck[] {
  const out: CbrCheck[] = [];
  if (product === "theory") return out;
  const until = s.theoryPassedOn ? theoryValidUntil(s.theoryPassedOn) : undefined;
  const expired = until !== undefined && until < today;
  out.push({ key: "authorization", done: !!s.authorizedOn, blocking: !s.authorizedOn });
  out.push({ key: "theory", done: !!s.theoryPassedOn && !expired, blocking: isPractical(product) && (!s.theoryPassedOn || expired), detail: until ? { until, expired } : undefined });
  out.push({ key: "health", done: s.health === "approved", blocking: s.health !== "approved" });
  return out;
}

/** True when nothing blocks reserving this product. */
export const readyToReserve = (s: CbrStudentState, product: CbrProduct, today?: string) => cbrChecklist(s, product, today).every((c) => !c.blocking);

/** Share of practical exams passed (passed / (passed + failed + no_show)); null if none taken. */
export function passRate(results: { product: CbrProduct; status: CbrStatus }[]): { rate: number | null; taken: number; passed: number } {
  const taken = results.filter((r) => isPractical(r.product) && ["passed", "failed", "no_show"].includes(r.status));
  const passed = taken.filter((r) => r.status === "passed").length;
  return { rate: taken.length ? passed / taken.length : null, taken: taken.length, passed };
}
