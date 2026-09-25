import type { NormalizedPaymentEvent } from "../services/billing";

export interface CheckoutRequest {
  paymentId: string;
  schoolId: string;
  amountCents: number;
  currency: string;
  description: string;
  customerEmail: string | null;
  reference: string;
  successUrl: string;
  cancelUrl: string;
  /** School's connected account (e.g. Stripe Connect), so funds settle to the school directly. */
  connectedAccountId: string | null;
  idempotencyKey: string;
}

export interface CheckoutSession {
  url: string;
  providerCheckoutId: string;
}

export interface VerifiedWebhook {
  /** From our own metadata; null when the provider event does not carry it (e.g. refunds). */
  schoolId: string | null;
  event: NormalizedPaymentEvent;
}

/** Add a provider (Mollie, Adyen, …) by implementing this and registering it in ./index.ts. */
export interface PaymentProvider {
  readonly name: string;
  createCheckout(req: CheckoutRequest): Promise<CheckoutSession>;
  /** Verify the signature and translate the payload. Throws on a bad signature. */
  verifyWebhook(rawBody: string, headers: Headers): Promise<VerifiedWebhook>;
}
