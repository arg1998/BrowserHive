/** @module features/theme/contrast — WCAG contrast from `oklch()` token strings (dev-only `/theme` gallery) */

/** sRGB triplet 0–1. */
export type Rgb = readonly [number, number, number];

/** Parse `oklch(L C H)` / `oklch(L C H / A)`; `null` for anything else. */
export function parseOklch(
  text: string,
): { readonly l: number; readonly c: number; readonly h: number } | null {
  const match = /oklch\(\s*([\d.]+)%?\s+([\d.]+)\s+([\d.]+)/i.exec(text);
  if (match === null) return null;
  const l = Number(match[1]);
  return { l: text.includes('%') ? l / 100 : l, c: Number(match[2]), h: Number(match[3]) };
}

/** OKLCH → linear sRGB → gamma-encoded sRGB (clamped). */
export function oklchToRgb(l: number, c: number, h: number): Rgb {
  const hr = (h * Math.PI) / 180;
  const a = c * Math.cos(hr);
  const b = c * Math.sin(hr);
  const l_ = l + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = l - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = l - 0.0894841775 * a - 1.291485548 * b;
  const l3 = l_ ** 3;
  const m3 = m_ ** 3;
  const s3 = s_ ** 3;
  const r = 4.0767416621 * l3 - 3.3077115913 * m3 + 0.2309699292 * s3;
  const g = -1.2684380046 * l3 + 2.6097574011 * m3 - 0.3413193965 * s3;
  const bl = -0.0041960863 * l3 - 0.7034186147 * m3 + 1.707614701 * s3;
  const gamma = (v: number) => {
    const x = Math.min(1, Math.max(0, v));
    return x <= 0.0031308 ? 12.92 * x : 1.055 * x ** (1 / 2.4) - 0.055;
  };
  return [gamma(r), gamma(g), gamma(bl)];
}

/** Relative luminance of gamma-encoded sRGB. */
export function luminance([r, g, b]: Rgb): number {
  const lin = (v: number) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

/** WCAG contrast ratio between two colours. */
export function contrastRatio(a: Rgb, b: Rgb): number {
  const la = luminance(a);
  const lb = luminance(b);
  const [hi, lo] = la > lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

/** Contrast between two `oklch()` strings; `null` when either does not parse. */
export function contrastOf(fg: string, bg: string): number | null {
  const f = parseOklch(fg);
  const b = parseOklch(bg);
  if (f === null || b === null) return null;
  return contrastRatio(oklchToRgb(f.l, f.c, f.h), oklchToRgb(b.l, b.c, b.h));
}
