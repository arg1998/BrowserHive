/** @module interface/mcp/tools/state/headers — identity-owned header refusal and viewport clamping for stealth/fingerprint sessions. */

import type { AppliedIdentity } from '../../../../ports/browser-driver.ts';

/**
 * Headers whose values the presented identity owns. They are written together by one CDP
 * `Emulation.setUserAgentOverride` call so the UA, its UA-CH breakdown and the language list agree;
 * replacing one in isolation is how a "Chrome" UA ends up beside "Chromium" client hints.
 */
export const IDENTITY_OWNED_HEADERS: ReadonlySet<string> = new Set([
  'user-agent',
  'accept-language',
  'sec-ch-ua',
  'sec-ch-ua-mobile',
  'sec-ch-ua-platform',
  'sec-ch-ua-platform-version',
  'sec-ch-ua-arch',
  'sec-ch-ua-bitness',
  'sec-ch-ua-model',
  'sec-ch-ua-full-version',
  'sec-ch-ua-full-version-list',
  'sec-ch-ua-wow64',
]);

/**
 * Splits a header bag into entries to apply and identity-owned names to refuse. Refusing rather
 * than throwing is deliberate: agents set whole bags for one legitimate header. Off ⇒ unchanged.
 */
export function splitIdentityHeaders(
  headers: Readonly<Record<string, string>>,
  identityOn: boolean,
): { accepted: Record<string, string>; rejected: string[] } {
  if (!identityOn) return { accepted: { ...headers }, rejected: [] };
  const accepted: Record<string, string> = {};
  const rejected: string[] = [];
  for (const [name, value] of Object.entries(headers)) {
    if (IDENTITY_OWNED_HEADERS.has(name.toLowerCase())) rejected.push(name);
    else accepted[name] = value;
  }
  return { accepted, rejected };
}

/**
 * Clamps a requested viewport so it still fits the display the session claims. The screen/window
 * metrics were frozen into an init script at launch; an unbounded resize could hand the page an
 * inner window larger than its own screen. The ceiling is the asserted screen width and the launch
 * viewport height (the session exposes the applied display only, not the window insets). A session
 * with no asserted display is unclamped.
 */
export function clampToAssertedDisplay(
  identity: AppliedIdentity | null,
  width: number,
  height: number,
): { width: number; height: number; clamped: boolean } {
  const display = identity?.display ?? null;
  if (display === null) return { width, height, clamped: false };
  const maxWidth = Math.max(1, display.screen.width);
  const maxHeight = Math.max(1, Math.min(display.screen.height, display.viewport.height));
  const w = Math.min(width, maxWidth);
  const h = Math.min(height, maxHeight);
  return { width: w, height: h, clamped: w !== width || h !== height };
}
