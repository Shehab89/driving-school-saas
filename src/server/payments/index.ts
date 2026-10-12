import { PolicyError } from "@/lib/errors";
import { StripePaymentProvider } from "./stripe";
import type { PaymentProvider } from "./types";

const registry = new Map<string, () => PaymentProvider>([["stripe", () => new StripePaymentProvider()]]);
const instances = new Map<string, PaymentProvider>();

export function getPaymentProvider(name: string): PaymentProvider {
  let p = instances.get(name);
  if (!p) {
    const factory = registry.get(name);
    if (!factory) throw new PolicyError(`Payment provider "${name}" is not configured`, "provider_not_configured");
    try {
      p = factory();
    } catch (err) {
      // Usually missing API keys: a configuration gap, not a crash. Callers show a friendly message.
      throw new PolicyError(`Payment provider "${name}" is not set up: ${(err as Error).message}`, "provider_not_configured");
    }
    instances.set(name, p);
  }
  return p;
}

/** Tests register fakes here. */
export function registerPaymentProvider(name: string, provider: PaymentProvider) {
  instances.set(name, provider);
}
