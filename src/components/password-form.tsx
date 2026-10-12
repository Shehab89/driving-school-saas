import { redirect } from "next/navigation";
import type { Translate } from "@/i18n";
import { AppError } from "@/lib/errors";
import { createSession, requireActor } from "@/server/auth/session";
import { changePassword } from "@/server/services/auth";
import { deliverNotifications } from "@/server/jobs";
import { str } from "@/server/web";
import { getI18n } from "@/i18n/server";
import { after } from "next/server";

async function change(back: string, fd: FormData) {
  "use server";
  const { t } = await getI18n();
  const actor = await requireActor();
  const next = str(fd, "password");
  const sep = back.includes("?") ? "&" : "?";
  if (next !== str(fd, "confirm")) redirect(`${back}${sep}error=${encodeURIComponent(t("auth.passwordsDontMatch"))}`);
  let user;
  try {
    user = await changePassword(actor.userId, str(fd, "current"), next);
  } catch (err) {
    redirect(`${back}${sep}error=${encodeURIComponent(err instanceof AppError ? err.message : t("errors.generic"))}`);
  }
  after(() => deliverNotifications(10).catch(() => undefined));
  // This device stays signed in with a fresh session; all others are revoked.
  await createSession({ sub: user.id, sid: user.school_id, role: user.role, tv: user.token_version });
  redirect(`${back}${sep}ok=${encodeURIComponent(t("auth.resetDone"))}`);
}

/** "Change password" card for any signed-in user. */
export function PasswordForm({ t, back }: { t: Translate; back: string }) {
  return (
    <form action={change.bind(null, back)} className="card">
      <h2>{t("auth.changePassword")}</h2>
      <div className="field">
        <label htmlFor="current">{t("auth.currentPassword")}</label>
        <input id="current" name="current" type="password" autoComplete="current-password" required dir="ltr" />
      </div>
      <div className="field">
        <label htmlFor="new-password">{t("auth.newPassword")}</label>
        <input id="new-password" name="password" type="password" minLength={10} autoComplete="new-password" required dir="ltr" />
      </div>
      <div className="field">
        <label htmlFor="confirm-password">{t("auth.repeatPassword")}</label>
        <input id="confirm-password" name="confirm" type="password" minLength={10} autoComplete="new-password" required dir="ltr" />
      </div>
      <button type="submit">{t("auth.changePassword")}</button>
    </form>
  );
}
