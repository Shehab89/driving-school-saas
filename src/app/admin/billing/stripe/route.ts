import { redirect } from "next/navigation";
import { withTenant } from "@/lib/db";
import { requireSchoolActor } from "@/server/auth/session";
import { userPrincipal } from "@/server/principal";
import { refreshStripeStatus, startStripeOnboarding } from "@/server/payments/connect";
import { runAction } from "@/server/web";
import { getPt } from "@/i18n/server";

export const dynamic = "force-dynamic";

/**
 * Where Stripe's hosted onboarding sends the owner back to.
 * ?return=1  finished (or left) onboarding: read the account status from Stripe.
 * ?refresh=1 the onboarding link expired: make a fresh one and go back to Stripe.
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const pt = await getPt();
  if (url.searchParams.has("refresh")) {
    let next: string;
    try {
      const actor = await requireSchoolActor("school:manage_integrations");
      next = (await withTenant(actor.schoolId, (tx) => startStripeOnboarding(tx, userPrincipal(actor)))).url;
    } catch (err) {
      // Shows the error as a banner on the billing page.
      return runAction(() => Promise.reject(err), { back: "/admin/billing" });
    }
    redirect(next);
  }
  let ready = false;
  return runAction(async () => {
    const actor = await requireSchoolActor("school:manage_integrations");
    const a = await withTenant(actor.schoolId, (tx) => refreshStripeStatus(tx, userPrincipal(actor)));
    ready = Boolean(a?.charges_enabled);
  }, {
    back: "/admin/billing",
    okMessage: () => (ready ? pt("Stripe is connected. Online payments now go to your own account.") : pt("Stripe still needs a few details before you can receive payments.")),
  });
}
