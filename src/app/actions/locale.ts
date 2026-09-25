"use server";
import { isLocale } from "@/i18n";
import { setLocaleCookie } from "@/i18n/server";
import { getActor } from "@/server/auth/session";
import { saveUserLocale } from "@/server/services/auth";

/** Switch the UI language; also remembered on the account for the next login. */
export async function setLocaleAction(locale: string) {
  if (!isLocale(locale)) return;
  await setLocaleCookie(locale);
  const actor = await getActor();
  if (actor) await saveUserLocale(actor.userId, actor.schoolId, locale);
}
