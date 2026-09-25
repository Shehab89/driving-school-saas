import { redirect } from "next/navigation";
import { sp, type SearchParams } from "@/components/ui";
import { getI18n } from "@/i18n/server";
import { getActor } from "@/server/auth/session";
import { homePathFor } from "@/lib/rbac";
import { LoginForm } from "./form";

/** School portal sign-in (owners, admins, SaaS admins; also works for everyone). */
export default async function LoginPage({ searchParams }: { searchParams: SearchParams }) {
  const params = await sp(searchParams);
  const actor = await getActor();
  if (actor) redirect(homePathFor(actor.role));
  const { t, locale } = await getI18n();
  return <LoginForm app="portal" t={t} locale={locale} params={params} />;
}
