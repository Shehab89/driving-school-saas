import "server-only";
import { cookies, headers } from "next/headers";
import { DEFAULT_LOCALE, dir, formatter, isLocale, negotiate, translator, type Locale } from "./index";

export const LOCALE_COOKIE = "lang";

/** Cookie (explicit choice, also set at login from the user's saved preference) → Accept-Language → English. */
export async function getLocale(): Promise<Locale> {
  const fromCookie = (await cookies()).get(LOCALE_COOKIE)?.value;
  if (isLocale(fromCookie)) return fromCookie;
  return negotiate((await headers()).get("accept-language")) ?? DEFAULT_LOCALE;
}

export async function getI18n(zone = "Europe/Amsterdam") {
  const locale = await getLocale();
  return { locale, dir: dir(locale), t: translator(locale), f: formatter(locale, zone) };
}
export type I18n = Awaited<ReturnType<typeof getI18n>>;

export async function setLocaleCookie(locale: Locale) {
  (await cookies()).set(LOCALE_COOKIE, locale, { path: "/", maxAge: 60 * 60 * 24 * 365, sameSite: "lax", httpOnly: false });
}
