import { Flash, Shell, sp, type SearchParams } from "@/components/ui";
import { PasswordForm } from "@/components/password-form";
import { requirePage } from "@/server/auth/session";
import { translator } from "@/i18n";

/** Account page for portal users (owners, admins, platform admins). The portal is English-only. */
export default async function AccountPage({ searchParams }: { searchParams: SearchParams }) {
  const q = await sp(searchParams);
  const actor = await requirePage();
  return (
    <Shell role={actor.role} title="Account">
      <h1>Account</h1>
      <Flash searchParams={q} />
      <section className="card">
        <dl className="kv"><dt>E-mail</dt><dd>{actor.email}</dd><dt>Role</dt><dd>{actor.role.replace(/_/g, " ")}</dd></dl>
      </section>
      <PasswordForm t={translator("en")} back="/account" />
    </Shell>
  );
}
