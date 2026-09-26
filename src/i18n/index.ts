/**
 * Minimal, dependency-free i18n: typed dictionaries, {placeholder}
 * interpolation, RTL detection and locale-aware date/money formatting.
 */
import { DateTime } from "luxon";
import en, { type Dictionary } from "./en";
import nl from "./nl";
import ar from "./ar";

export const LOCALES = ["en", "nl", "ar"] as const;
export type Locale = (typeof LOCALES)[number];
export const DEFAULT_LOCALE: Locale = "en";

const DICTIONARIES: Record<Locale, Dictionary> = { en, nl, ar };

export function isLocale(v: unknown): v is Locale {
  return typeof v === "string" && (LOCALES as readonly string[]).includes(v);
}

export function dir(locale: Locale): "ltr" | "rtl" {
  return locale === "ar" ? "rtl" : "ltr";
}

/** BCP-47 tag for Intl/Luxon. Arabic keeps Latin digits for times and prices. */
export function intlTag(locale: Locale): string {
  return locale === "ar" ? "ar-u-nu-latn" : locale === "nl" ? "nl-NL" : "en-GB";
}

/** Pick the best supported locale from an Accept-Language header. */
export function negotiate(acceptLanguage: string | null | undefined): Locale {
  if (!acceptLanguage) return DEFAULT_LOCALE;
  const ranked = acceptLanguage
    .split(",")
    .map((part) => {
      const [tag, ...params] = part.trim().split(";");
      const q = params.find((p) => p.trim().startsWith("q="));
      return { base: (tag ?? "").toLowerCase().split("-")[0], q: q ? Number(q.split("=")[1]) : 1 };
    })
    .filter((x) => x.base && !Number.isNaN(x.q))
    .sort((a, b) => b.q - a.q);
  return (ranked.find((r) => isLocale(r.base))?.base as Locale | undefined) ?? DEFAULT_LOCALE;
}

type Leaves<T, P extends string = ""> = {
  [K in keyof T & string]: T[K] extends string ? `${P}${K}` : Leaves<T[K], `${P}${K}.`>;
}[keyof T & string];
export type MessageKey = Leaves<Dictionary>;
export type Params = Record<string, string | number>;

function lookup(dict: Dictionary, key: string): string | undefined {
  let node: unknown = dict;
  for (const part of key.split(".")) {
    if (node && typeof node === "object" && part in node) node = (node as Record<string, unknown>)[part];
    else return undefined;
  }
  return typeof node === "string" ? node : undefined;
}

export function interpolate(template: string, params?: Params): string {
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (m, name: string) => (name in params ? String(params[name]) : m));
}

export type Translate = (key: MessageKey, params?: Params) => string;

export function translator(locale: Locale): Translate {
  const dict = DICTIONARIES[locale];
  return (key, params) => interpolate(lookup(dict, key) ?? lookup(en, key) ?? key, params);
}

/** Translate a key that is only known at runtime (e.g. an error code); undefined when missing. */
export function tryTranslate(locale: Locale, key: string, params?: Params): string | undefined {
  const s = lookup(DICTIONARIES[locale], key);
  return s === undefined ? undefined : interpolate(s, params);
}

export function formatter(locale: Locale, zone: string) {
  const tag = intlTag(locale);
  const dt = (d: Date | string) => DateTime.fromJSDate(new Date(d), { zone }).setLocale(tag);
  return {
    date: (d: Date | string) => dt(d).toFormat("cccc d LLLL yyyy"),
    shortDate: (d: Date | string) => dt(d).toFormat("ccc d LLL"),
    dayMonth: (d: Date | string) => dt(d).toFormat("d LLLL"),
    time: (d: Date | string) => dt(d).toFormat("HH:mm"),
    // Wrapped in Unicode left-to-right isolates so "12:00–13:00" never flips inside Arabic text.
    range: (a: Date | string, b: Date | string) => `\u2066${dt(a).toFormat("HH:mm")}–${dt(b).toFormat("HH:mm")}\u2069`,
    dateTime: (d: Date | string) => dt(d).toFormat("ccc d LLL, HH:mm"),
    /** For YYYY-MM-DD due dates. */
    isoDate: (iso: string) => DateTime.fromISO(iso, { zone }).setLocale(tag).toFormat("d LLL yyyy"),
    number: (v: number, digits = 1) => new Intl.NumberFormat(tag, { maximumFractionDigits: digits }).format(v),
    money: (cents: number, currency: string) => new Intl.NumberFormat(tag, { style: "currency", currency }).format(cents / 100),
    weekday: (isoWeekday: number) => DateTime.fromObject({ weekday: isoWeekday as 1 }, { zone }).setLocale(tag).toFormat("cccc"),
    weekdayShort: (isoWeekday: number) => DateTime.fromObject({ weekday: isoWeekday as 1 }, { zone }).setLocale(tag).toFormat("ccc"),
    luxon: dt,
    tag,
  };
}
export type Formatter = ReturnType<typeof formatter>;
