/**
 * The ways a school can let students pay. Online methods run through the
 * payment provider's checkout; offline ones are paid outside the app and
 * recorded by staff ("Mark paid").
 */
export const PAYMENT_METHODS = ["ideal", "card", "bancontact", "bank_transfer", "cash", "pin"] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

export const ONLINE_METHODS = ["ideal", "card", "bancontact"] as const satisfies readonly PaymentMethod[];
export type OnlineMethod = (typeof ONLINE_METHODS)[number];

/** Methods staff can pick when recording a payment by hand. */
export const MANUAL_METHODS = ["cash", "pin", "bank_transfer"] as const;
export type ManualMethod = (typeof MANUAL_METHODS)[number];

export const DEFAULT_PAYMENT_METHODS: PaymentMethod[] = ["ideal", "card", "bank_transfer", "cash"];

export function isPaymentMethod(v: unknown): v is PaymentMethod {
  return typeof v === "string" && (PAYMENT_METHODS as readonly string[]).includes(v);
}

export function isManualMethod(v: unknown): v is ManualMethod {
  return typeof v === "string" && (MANUAL_METHODS as readonly string[]).includes(v);
}

/** Keep known methods once, in the canonical order. */
export function normalizeMethods(input: readonly unknown[]): PaymentMethod[] {
  return PAYMENT_METHODS.filter((m) => input.includes(m));
}

export function onlineMethods(methods: readonly string[]): OnlineMethod[] {
  return ONLINE_METHODS.filter((m) => methods.includes(m));
}

export function offlineMethods(methods: readonly string[]): ManualMethod[] {
  return MANUAL_METHODS.filter((m) => methods.includes(m));
}

