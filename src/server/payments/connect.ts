/**
 * Stripe Connect onboarding: a school connects its own Stripe account so
 * lesson payments settle straight to the school (direct charges, the school
 * pays Stripe's fees and sees everything in its own Stripe dashboard).
 *
 * Flow: owner presses "Connect Stripe" -> we create (or reuse) the school's
 * connected account and an Account Link -> Stripe's hosted onboarding ->
 * back to /admin/billing/stripe?return=1, where we read the account status.
 * Account Links expire after a few minutes, so "Continue" makes a fresh one.
 */
import Stripe from "stripe";
import { one, type Tx } from "@/lib/db";
import { env } from "@/lib/env";
import { ForbiddenError, PolicyError } from "@/lib/errors";
import { log } from "@/lib/log";
import { can } from "@/lib/rbac";
import type { Principal } from "../principal";
import { audit } from "../services/audit";

export interface ConnectAccountStatus {
  accountId: string;
  chargesEnabled: boolean;
  payoutsEnabled: boolean;
  detailsSubmitted: boolean;
}

export interface ConnectProvider {
  createAccount(input: { email: string | null; businessName: string; country: string; schoolId: string }): Promise<{ accountId: string }>;
  createOnboardingLink(input: { accountId: string; refreshUrl: string; returnUrl: string }): Promise<{ url: string }>;
  getStatus(accountId: string): Promise<ConnectAccountStatus>;
}

export class StripeConnectProvider implements ConnectProvider {
  private stripe: Stripe;
  constructor(secretKey = env.stripeSecretKey) {
    this.stripe = new Stripe(secretKey);
  }

  async createAccount(input: { email: string | null; businessName: string; country: string; schoolId: string }) {
    const account = await this.stripe.accounts.create(
      {
        country: input.country,
        email: input.email ?? undefined,
        business_profile: { name: input.businessName, mcc: "8299" /* schools and educational services */ },
        // Same as a "Standard" account: the school has the full Stripe dashboard,
        // pays Stripe's fees itself and Stripe collects the onboarding details.
        controller: {
          stripe_dashboard: { type: "full" },
          fees: { payer: "account" },
          losses: { payments: "stripe" },
          requirement_collection: "stripe",
        },
        metadata: { school_id: input.schoolId },
      },
      { idempotencyKey: `connect-account:${input.schoolId}` },
    );
    return { accountId: account.id };
  }

  async createOnboardingLink(input: { accountId: string; refreshUrl: string; returnUrl: string }) {
    const link = await this.stripe.accountLinks.create({
      account: input.accountId,
      refresh_url: input.refreshUrl,
      return_url: input.returnUrl,
      type: "account_onboarding",
    });
    return { url: link.url };
  }

  async getStatus(accountId: string): Promise<ConnectAccountStatus> {
    const a = await this.stripe.accounts.retrieve(accountId);
    return { accountId: a.id, chargesEnabled: Boolean(a.charges_enabled), payoutsEnabled: Boolean(a.payouts_enabled), detailsSubmitted: Boolean(a.details_submitted) };
  }
}

let override: ConnectProvider | null = null;
let instance: ConnectProvider | null = null;

/** Tests register a fake here. */
export function setConnectProvider(p: ConnectProvider | null) {
  override = p;
}

function connectProvider(): ConnectProvider {
  if (override) return override;
  if (!instance) {
    try {
      instance = new StripeConnectProvider();
    } catch (err) {
      throw new PolicyError(`Stripe is not set up on this server: ${(err as Error).message}`, "provider_not_configured");
    }
  }
  return instance;
}

export interface SchoolStripeAccount {
  provider_account_id: string;
  status: "pending" | "active" | "disabled";
  charges_enabled: boolean;
  payouts_enabled: boolean;
  details_submitted: boolean;
  status_checked_at: Date | null;
  source: "manual" | "onboarding";
}

export async function getSchoolStripeAccount(tx: Tx): Promise<SchoolStripeAccount | null> {
  return one<SchoolStripeAccount>(
    tx,
    `SELECT provider_account_id, status, charges_enabled, payouts_enabled, details_submitted, status_checked_at, source
       FROM school_payment_accounts WHERE provider = 'stripe'`,
  );
}

function assertOwner(p: Principal) {
  if (p.type !== "user" || !can(p.actor.role, "school:manage_integrations")) throw new ForbiddenError();
}

/** Create the school's connected account when needed and return a Stripe onboarding URL. */
export async function startStripeOnboarding(tx: Tx, p: Principal): Promise<{ url: string }> {
  assertOwner(p);
  const provider = connectProvider();
  let account = await getSchoolStripeAccount(tx);
  if (!account) {
    const school = (await one<{ name: string; email: string | null }>(tx, `SELECT name, email FROM schools WHERE id = $1`, [p.schoolId]))!;
    const { accountId } = await provider.createAccount({ email: school.email, businessName: school.name, country: "NL", schoolId: p.schoolId });
    await tx.query(
      `INSERT INTO school_payment_accounts (school_id, provider, provider_account_id, status, source) VALUES ($1,'stripe',$2,'pending','onboarding')`,
      [p.schoolId, accountId],
    );
    await audit(tx, p, "stripe.account_created", "school", p.schoolId, { account: accountId });
    account = (await getSchoolStripeAccount(tx))!;
  }
  const base = `${env.appUrl}/admin/billing/stripe`;
  return provider.createOnboardingLink({ accountId: account.provider_account_id, refreshUrl: `${base}?refresh=1`, returnUrl: `${base}?return=1` });
}

/**
 * Read the account's status from Stripe and store it. Payments only go to
 * the connected account once Stripe says it can accept charges.
 */
export async function refreshStripeStatus(tx: Tx, p: Principal): Promise<SchoolStripeAccount | null> {
  assertOwner(p);
  const account = await getSchoolStripeAccount(tx);
  if (!account) return null;
  let s: ConnectAccountStatus;
  try {
    s = await connectProvider().getStatus(account.provider_account_id);
  } catch (err) {
    if (err instanceof PolicyError) throw err;
    log.error("stripe.connect_status_failed", { err });
    throw new PolicyError("Could not reach Stripe. Please try again in a minute.", "provider_unavailable");
  }
  await tx.query(
    `UPDATE school_payment_accounts
        SET charges_enabled = $1, payouts_enabled = $2, details_submitted = $3, status_checked_at = now(),
            status = CASE WHEN $1 THEN 'active' ELSE 'pending' END
      WHERE provider = 'stripe'`,
    [s.chargesEnabled, s.payoutsEnabled, s.detailsSubmitted],
  );
  await audit(tx, p, "stripe.status_checked", "school", p.schoolId, { charges: s.chargesEnabled, payouts: s.payoutsEnabled });
  return getSchoolStripeAccount(tx);
}

/** Owner pastes an existing acct_… id (schools that already use Stripe Connect elsewhere). */
export async function setManualStripeAccount(tx: Tx, p: Principal, accountId: string) {
  assertOwner(p);
  if (!/^acct_[A-Za-z0-9]{6,40}$/.test(accountId)) throw new PolicyError("A Stripe account ID starts with acct_.", "invalid_account");
  await tx.query(
    `INSERT INTO school_payment_accounts (school_id, provider, provider_account_id, status, charges_enabled, payouts_enabled, details_submitted, source)
     VALUES ($1,'stripe',$2,'active',true,true,true,'manual')
     ON CONFLICT (school_id, provider) DO UPDATE SET provider_account_id = EXCLUDED.provider_account_id, status = 'active',
       charges_enabled = true, payouts_enabled = true, details_submitted = true, source = 'manual', status_checked_at = NULL`,
    [p.schoolId, accountId],
  );
  await audit(tx, p, "integrations.updated", "school", p.schoolId, { stripe: true });
}

/** Stop sending payments to the connected account (the Stripe account itself is not deleted). */
export async function disconnectStripe(tx: Tx, p: Principal) {
  assertOwner(p);
  await tx.query(`DELETE FROM school_payment_accounts WHERE provider = 'stripe'`);
  await audit(tx, p, "stripe.disconnected", "school", p.schoolId, {});
}
