/** Colour helpers for a school's own brand colour (#rrggbb). */

/** WCAG relative luminance, 0 (black) … 1 (white). */
export function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}

/** Black or white text, whichever reads better on the given colour (WCAG relative luminance). */
export function readableOn(hex: string): "#16181d" | "#ffffff" {
  const l = luminance(hex);
  // Contrast with white = 1.05 / (l + 0.05); with near-black ≈ (l + 0.05) / 0.06.
  return 1.05 / (l + 0.05) >= (l + 0.05) / 0.06 ? "#ffffff" : "#16181d";
}
