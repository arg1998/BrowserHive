/** @module features/sessions/detail/viewport — `set_viewport` presets ("My monitor" + common resolutions) and form validation against the contracts bounds (200–10000) */
import { SetViewportRequest, VIEWPORT_MAX, VIEWPORT_MIN } from '@browserhive/contracts/http';

/** One resolution. */
export interface Resolution {
  readonly label: string;
  readonly width: number;
  readonly height: number;
}

/** Common screen resolution presets. */
export const RESOLUTION_PRESETS: readonly Resolution[] = [
  { label: '1920 × 1080 · FHD', width: 1920, height: 1080 },
  { label: '1600 × 900', width: 1600, height: 900 },
  { label: '1440 × 900', width: 1440, height: 900 },
  { label: '1366 × 768', width: 1366, height: 768 },
  { label: '1280 × 720 · HD', width: 1280, height: 720 },
  { label: '1024 × 768', width: 1024, height: 768 },
  { label: '768 × 1024 · iPad', width: 768, height: 1024 },
  { label: '414 × 896 · iPhone XR', width: 414, height: 896 },
  { label: '390 × 844 · iPhone', width: 390, height: 844 },
  { label: '360 × 800 · Android', width: 360, height: 800 },
];

/** Clamp to the protocol bounds. */
export function clampViewport(n: number): number {
  return Math.max(VIEWPORT_MIN, Math.min(VIEWPORT_MAX, Math.round(n)));
}

/** "My monitor" first, then presets without a duplicate of it. */
export function resolutionOptions(
  screen: { readonly width: number; readonly height: number } | undefined,
): readonly Resolution[] {
  if (screen === undefined || screen.width <= 0 || screen.height <= 0) return RESOLUTION_PRESETS;
  const w = clampViewport(screen.width);
  const h = clampViewport(screen.height);
  const monitor = { label: `My monitor · ${w} × ${h}`, width: w, height: h };
  return [monitor, ...RESOLUTION_PRESETS.filter((r) => !(r.width === w && r.height === h))];
}

/** Validation result for the free-form viewport form. */
export type ViewportValidation =
  | { readonly ok: true; readonly value: { readonly width: number; readonly height: number } }
  | { readonly ok: false; readonly errors: { readonly width?: string; readonly height?: string } };

/** Validate raw text inputs. */
export function validateViewport(width: string, height: string): ViewportValidation {
  const message = `Enter a whole number between ${VIEWPORT_MIN} and ${VIEWPORT_MAX}.`;
  const parse = (raw: string) => (/^\d+$/.test(raw.trim()) ? Number(raw.trim()) : Number.NaN);
  const result = SetViewportRequest.safeParse({ width: parse(width), height: parse(height) });
  if (result.success) return { ok: true, value: result.data };
  const errors: { width?: string; height?: string } = {};
  for (const issue of result.error.issues) {
    if (issue.path[0] === 'width') errors.width = message;
    if (issue.path[0] === 'height') errors.height = message;
  }
  return { ok: false, errors };
}
