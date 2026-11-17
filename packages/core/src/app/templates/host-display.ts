/** @module app/templates/host-display — the display check before a headed host starts (spec 13 §3.11, D29): recent Chromium opens a "headed" browser without any display (it falls back to a headless Ozone platform), so on Linux a headed host start without `DISPLAY` or `WAYLAND_DISPLAY` fails as `no_display` before a browser is launched. macOS and Windows are left to the launch itself. */

import { AppError } from '../../kernel/errors/app-error.ts';

/** The operator-facing cause of a start refused for want of a display. */
export const NO_DISPLAY_MESSAGE =
  'no display: a headed template host needs DISPLAY or WAYLAND_DISPLAY on Linux (run BrowserHive in a desktop session or under `xvfb-run -a`, or make the template headless)';

/** True when `value` names a display (set and not empty). */
function present(value: string | undefined): boolean {
  return value !== undefined && value.trim() !== '';
}

/**
 * True when a headed host cannot get a window on this machine: Linux with neither `DISPLAY` nor
 * `WAYLAND_DISPLAY`. Always false on other platforms.
 */
export function displayMissing(
  platform: string,
  env: Readonly<Record<string, string | undefined>>,
): boolean {
  if (platform !== 'linux') return false;
  return !present(env['DISPLAY']) && !present(env['WAYLAND_DISPLAY']);
}

/**
 * A host start refused before launch: `INTERNAL_ERROR` with `ref: 'no_display'`, the same shape as a
 * launch that failed with Chromium's display errors, so the lifecycle sets the host `failed` with
 * `reason: 'no_display'` and launches answer `TEMPLATE_DISABLED` `needs_operator`.
 */
export function noDisplayError(): AppError<'INTERNAL_ERROR'> {
  return new AppError('INTERNAL_ERROR', { ref: 'no_display' }, { message: NO_DISPLAY_MESSAGE });
}

/**
 * Throws {@link noDisplayError} for a headed template on a machine without a display. `platform`
 * absent (tests, fixtures) skips the check.
 */
export function assertDisplay(
  template: { readonly headless: boolean },
  platform: string | undefined,
  env: Readonly<Record<string, string | undefined>>,
): void {
  if (template.headless || platform === undefined) return;
  if (displayMissing(platform, env)) throw noDisplayError();
}
