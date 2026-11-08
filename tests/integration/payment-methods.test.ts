import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closePools, one, withPlatform, withTenant } from "@/lib/db";
import { resolvePayLink } from "@/server/payments/checkout";
import { registerPaymentProvider } from "@/server/payments";
import type { CheckoutRequest, PaymentProvider } from "@/server/payments/types";
import { disconnectStripe, refreshStripeStatus, setConnectProvider, setManualStripeAccount, startStripeOnboarding, type ConnectProvider } from "@/server/payments/connect";
import { createPackage, purchasePackage } from "@/server/services/packages";
import { recordManualPayment } from "@/server/services/billing";
import { reconciliationRows, parseRange } from "@/server/services/reports";
import { updateSchoolProfileAndSettings } from "@/server/services/schools";
import { asUser, createFixture, type Fixture } from "./helpers";

let f: Fixture;
const checkouts: CheckoutRequest[] = [];
const fakeStripe: PaymentProvider = {
  name: "stripe",
  async createCheckout(req) {
    checkouts.push(req);
    return { url: `https://checkout.example/${req.paymentId}`, providerCheckoutId: `cs_${checkouts.length}` };
  },
  async refund() {
    return { refundId: "re_1" };
  },
  async verifyWebhook() {
    throw new Error("not used");
  },
};

let charges = false;
const created: string[] = [];
const fakeConnect: ConnectProvider = {
  async createAccount({ schoolId }) {
    created.push(schoolId);
    return { accountId: `acct_test${created.length}${Math.random().toString(36).slice(2, 8)}` };
  },
  async createOnboardingLink({ accountId, returnUrl }) {
    return { url: `https://connect.stripe.example/${accountId}?return=${encodeURIComponent(returnUrl)}` };
  },
  async getStatus(accountId) {
    return { accountId, chargesEnabled: charges, payoutsEnabled: charges, detailsSubmitted: true };
  },
};

async function newPayment() {
  return withTenant(f.schoolId, async (tx) => {
    const pkg = await createPackage(tx, f.owner, { name: `P${Math.random()}`, lessonCount: 2, priceCents: 11000 });
    const r = await purchasePackage(tx, f.owner, { studentId: f.studentId, packageId: pkg.id });
    const pay = (await one<{ pay_token: string }>(tx, `SELECT pay_token FROM payments WHERE id = $1`, [r.paymentId]))!;
    return { id: r.paymentId, token: pay.pay_token };
  });
}

const setMethods = (methods: string[], note: string | null = null) =>
  withTenant(f.schoolId, (tx) => updateSchoolProfileAndSettings(tx, f.owner, { school: {}, settings: { payment_methods: methods, offline_payment_note: note } }));

beforeAll(async () => {
  f = await createFixture();
  registerPaymentProvider("stripe", fakeStripe);
  setConnectProvider(fakeConnect);
});
afterAll(async () => {
  setConnectProvider(null);
  await closePools();
});

describe("payment methods the school offers", () => {
  it("defaults to iDEAL, card, bank transfer and cash", async () => {
    const s = await withTenant(f.schoolId, (tx) => one<{ payment_methods: string[] }>(tx, `SELECT payment_methods FROM school_settings`));
    expect(s!.payment_methods).toEqual(["ideal", "card", "bank_transfer", "cash"]);
  });

  it("sends only the online methods the school turned on to the checkout", async () => {
    await setMethods(["card", "ideal", "cash", "bancontact"]);
    const p = await newPayment();
    const r = await resolvePayLink(p.token);
    expect(r.kind).toBe("redirect");
    expect(checkouts.at(-1)!.paymentMethodTypes).toEqual(["ideal", "card", "bancontact"]);
  });

  it("shows cash / PIN / bank instructions and never starts a checkout when nothing online is on", async () => {
    await withPlatform((tx) => tx.query(`UPDATE school_settings SET iban = 'NL91ABNA0417164300' WHERE school_id = $1`, [f.schoolId]));
    await setMethods(["cash", "pin", "bank_transfer"], "Pay your instructor in the car");
    const before = checkouts.length;
    const p = await newPayment();
    const r = await resolvePayLink(p.token);
    expect(r).toMatchObject({ kind: "offline", methods: ["cash", "pin", "bank_transfer"], iban: "NL91ABNA0417164300", note: "Pay your instructor in the car" });
    expect(checkouts.length).toBe(before);
  });

  it("hides the IBAN when the school does not take bank transfers", async () => {
    await setMethods(["cash"]);
    const r = await resolvePayLink((await newPayment()).token);
    expect(r).toMatchObject({ kind: "offline", methods: ["cash"], iban: null });
  });

  it("refuses an empty or unknown list", async () => {
    await expect(setMethods([])).rejects.toMatchObject({ code: "validation_error" });
    await expect(setMethods(["bitcoin"])).rejects.toMatchObject({ code: "validation_error" });
    await setMethods(["ideal", "bitcoin", "ideal"]);
    const s = await withTenant(f.schoolId, (tx) => one<{ payment_methods: string[] }>(tx, `SELECT payment_methods FROM school_settings`));
    expect(s!.payment_methods).toEqual(["ideal"]);
  });
});

describe("recording a payment by hand", () => {
  it("stores the method and the accountant export shows it", async () => {
    const p = await newPayment();
    await withTenant(f.schoolId, (tx) => recordManualPayment(tx, f.owner, p.id, "", "pin"));
    const row = await withTenant(f.schoolId, (tx) => one<{ method: string; status: string }>(tx, `SELECT method, status FROM payments WHERE id = $1`, [p.id]));
    expect(row).toEqual({ method: "pin", status: "paid" });
    const today = new Date().toISOString().slice(0, 10);
    const rows = await withTenant(f.schoolId, (tx) => reconciliationRows(tx, parseRange(today, today, "Europe/Amsterdam")));
    expect(rows.some((r) => r.method === "pin")).toBe(true);
  });

  it("rejects an unknown method", async () => {
    const p = await newPayment();
    await expect(withTenant(f.schoolId, (tx) => recordManualPayment(tx, f.owner, p.id, "", "cheque" as never))).rejects.toMatchObject({ code: "validation_error" });
  });
});

describe("Stripe Connect", () => {
  it("only the owner can connect", async () => {
    await expect(withTenant(f.schoolId, (tx) => startStripeOnboarding(tx, asUser(f.instructorActor)))).rejects.toMatchObject({ code: "forbidden" });
  });

  it("creates one account, sends the owner to Stripe and goes live only once Stripe allows charges", async () => {
    await setMethods(["ideal", "card"]);
    const first = await withTenant(f.schoolId, (tx) => startStripeOnboarding(tx, f.owner));
    expect(first.url).toContain("connect.stripe.example/acct_test");
    expect(first.url).toContain(encodeURIComponent("/admin/billing/stripe?return=1"));
    // A second click reuses the same account.
    await withTenant(f.schoolId, (tx) => startStripeOnboarding(tx, f.owner));
    expect(created.filter((id) => id === f.schoolId)).toHaveLength(1);

    // Not finished: payments must not be sent to the half-made account.
    charges = false;
    const pending = await withTenant(f.schoolId, (tx) => refreshStripeStatus(tx, f.owner));
    expect(pending).toMatchObject({ status: "pending", charges_enabled: false });
    await resolvePayLink((await newPayment()).token);
    expect(checkouts.at(-1)!.connectedAccountId).toBeNull();

    charges = true;
    const live = await withTenant(f.schoolId, (tx) => refreshStripeStatus(tx, f.owner));
    expect(live).toMatchObject({ status: "active", charges_enabled: true, payouts_enabled: true, source: "onboarding" });
    await resolvePayLink((await newPayment()).token);
    expect(checkouts.at(-1)!.connectedAccountId).toBe(live!.provider_account_id);
  });

  it("accepts a pasted acct_ id, validates it, and can disconnect", async () => {
    await expect(withTenant(f.schoolId, (tx) => setManualStripeAccount(tx, f.owner, "not-an-id"))).rejects.toMatchObject({ code: "invalid_account" });
    const id = `acct_manual${Math.random().toString(36).slice(2, 10)}`;
    await withTenant(f.schoolId, (tx) => setManualStripeAccount(tx, f.owner, id));
    await resolvePayLink((await newPayment()).token);
    expect(checkouts.at(-1)!.connectedAccountId).toBe(id);
    await withTenant(f.schoolId, (tx) => disconnectStripe(tx, f.owner));
    await resolvePayLink((await newPayment()).token);
    expect(checkouts.at(-1)!.connectedAccountId).toBeNull();
  });
});
