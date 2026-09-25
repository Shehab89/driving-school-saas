import { ValidationError } from "@/lib/errors";
import { StripePaymentProvider } from "./stripe";
import type { PaymentProvider } from "./types";

const registry = new Map<string, () => PaymentProvider>([["stripe", () => new StripePaymentProvider()]]);
const instances = new Map<string, PaymentProvider>();

export function getPaymentProvider(name: string): PaymentProvider {
  let p = instances.get(name);
  if (!p) {
    const factory = registry.get(name);
    if (!factory) throw new ValidationError(`Payment provider "${name}" is not configured`);
    p = factory();
    instances.set(name, p);
  }
  return p;
}

/** Tests register fakes here. */
export function registerPaymentProvider(name: string, provider: PaymentProvider) {
  instances.set(name, provider);
}
