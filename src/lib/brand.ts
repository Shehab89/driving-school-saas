/**
 * DriveDesk brand. The mark is a "D" drawn as a road: an asphalt road with a
 * dashed lane marking. Two colours: asphalt and lane amber.
 *   - company mark: asphalt road on a light tile, amber lane marking
 *   - student app:  amber tile, asphalt road, white lane marking
 *   - instructor app: asphalt tile, white road, amber lane marking
 */
export const BRAND = {
  asphalt: "#16181D",
  amber: "#F5B000",
  paper: "#FFFFFF",
} as const;

export type MarkVariant = "company" | "student" | "instructor";

const D_PATH = "M168 128 V384 H250 A128 128 0 0 0 250 128 Z";

export function markSvg(variant: MarkVariant, size = 512): string {
  const tile = variant === "student" ? BRAND.amber : variant === "instructor" ? BRAND.asphalt : BRAND.paper;
  const road = variant === "instructor" ? BRAND.paper : BRAND.asphalt;
  const lane = variant === "student" ? BRAND.paper : BRAND.amber;
  const border = variant === "company" ? `<rect x="8" y="8" width="496" height="496" rx="112" fill="none" stroke="#E4E6EA" stroke-width="16"/>` : "";
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 512 512" role="img" aria-label="DriveDesk"><rect width="512" height="512" rx="120" fill="${tile}"/>${border}<path d="${D_PATH}" fill="none" stroke="${road}" stroke-width="72" stroke-linejoin="round"/><path d="${D_PATH}" fill="none" stroke="${lane}" stroke-width="12" stroke-linejoin="round" stroke-dasharray="30 26" stroke-dashoffset="8"/></svg>`;
}

/** Horizontal lockup: mark + "drivedesk" wordmark (text uses the system UI font). */
export function lockupSvg(dark = false): string {
  const ink = dark ? BRAND.paper : BRAND.asphalt;
  const mark = markSvg(dark ? "instructor" : "company", 120).replace("<svg ", '<svg x="0" y="0" ');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="560" height="120" viewBox="0 0 560 120" role="img" aria-label="DriveDesk">${mark}<text x="148" y="80" font-family="-apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif" font-size="64" font-weight="800" letter-spacing="-2" fill="${ink}">drive<tspan fill="${ink}" opacity="0.55">desk</tspan></text><rect x="150" y="96" width="44" height="8" rx="4" fill="${BRAND.amber}"/></svg>`;
}
