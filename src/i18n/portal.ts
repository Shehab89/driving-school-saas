/**
 * School-portal translations (owner / office screens).
 *
 * The portal has many one-off labels, so it uses the English text itself as
 * the key (gettext style): `pt("Students")`, `pt("{count} overdue", { count })`.
 * portal-nl.ts and portal-ar.ts map that English text to Dutch and Arabic; a
 * missing entry falls back to English. A unit test (tests/unit/portal-i18n.test.ts)
 * fails when any pt("…") text in the code has no Dutch or Arabic translation.
 */
import { interpolate, type Locale, type Params } from "./index";
import nl from "./portal-nl";
import ar from "./portal-ar";

export type PortalTranslate = (english: string, params?: Params) => string;

export const PORTAL_DICTIONARIES: Record<Exclude<Locale, "en">, Record<string, string>> = { nl, ar };

export function portalTranslator(locale: Locale): PortalTranslate {
  const dict = locale === "en" ? null : PORTAL_DICTIONARIES[locale];
  return (english, params) => interpolate(dict?.[english] ?? english, params);
}

/** Marks an English portal text that is translated later with pt(value), so the translation test finds it. */
export const ptKey = <T extends string>(english: T): T => english;
