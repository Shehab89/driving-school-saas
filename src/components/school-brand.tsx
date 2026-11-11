import { luminance, readableOn } from "@/lib/color";
import { Mark } from "./brand";
import type { MarkVariant } from "@/lib/brand";

export interface SchoolBrandView {
  /** #rrggbb, already validated by the database. */
  color: string | null;
  /** /api/school-logo/<id>?v=… */
  logo: string | null;
}

/**
 * Replaces the DriveDesk amber with the school's own colour. Text on the
 * colour turns black or white, whichever reads better; in dark mode a very
 * dark school colour does not become the button colour (it would vanish).
 */
export function BrandStyle({ color }: { color: string | null | undefined }) {
  if (!color || !/^#[0-9a-f]{6}$/i.test(color)) return null;
  const on = readableOn(color);
  const dark = luminance(color) >= 0.1 ? `--primary:${color};--primary-text:${on};` : "";
  const css =
    `:root{--accent:${color};--accent-on:${on};--accent-soft:color-mix(in srgb,${color} 14%,#fff);--accent-ink:color-mix(in srgb,${color} 55%,#000);--ch-hi:${color}}` +
    `@media (prefers-color-scheme: dark){:root{${dark}--accent-soft:color-mix(in srgb,${color} 20%,#171a1f);--accent-ink:color-mix(in srgb,${color} 55%,#fff)}}`;
  return <style>{css}</style>;
}

/** The school's logo when it has one, otherwise the DriveDesk mark. */
export function SchoolMark({ brand, size, variant, name }: { brand?: SchoolBrandView | null; size: number; variant?: MarkVariant; name: string }) {
  if (brand?.logo) {
    // eslint-disable-next-line @next/next/no-img-element
    return <img className="school-logo" src={brand.logo} alt={name} height={size} style={{ height: size, maxWidth: size * 3 }} />;
  }
  return <Mark variant={variant} size={size} />;
}
