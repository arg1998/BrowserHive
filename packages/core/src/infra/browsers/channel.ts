/** @module infra/browsers/channel — public channel names and their Playwright `channel` mapping (spec 11 §2.1). */

import { Channel } from '@browserhive/contracts/enums';
import { AppError } from '../../kernel/errors/app-error.ts';

/**
 * Public channel names accepted by `launch_session`. Maps to Playwright's underlying
 * Chromium-family channels in {@link launchKwargsForChannel}.
 *
 * v1 is intentionally Chromium-only. Firefox / WebKit are deferred to v2; the architectural seam
 * lives in this file (swap the driver to multiplex on browser type).
 */
export const SUPPORTED_CHANNELS: readonly Channel[] = Channel.options;

/**
 * Map our public channel name to the Playwright `channel` option.
 *
 * - `chromium` → `channel: 'chromium'`; launches Playwright's bundled **full** Chromium in the new
 *   headless mode. This is deliberate: the alternative (`channel: undefined`) launches the stripped
 *   `chrome-headless-shell`, which leaks automation signals (a `HeadlessChrome` UA, no `window.chrome`,
 *   zero plugins, software-rendered WebGL). The full binary restores those real-browser signals at no
 *   dependency cost. `--incognito` stays unnecessary — per-session isolation comes from a fresh
 *   `newContext()` (memory) or a managed `userDataDir` (persistent), not from the flag.
 * - `chrome` → `channel: 'chrome'`; uses the user's installed Chrome.
 * - `edge` → `channel: 'msedge'`; uses the user's installed Edge.
 *
 * Internal — not exported. Callers go through {@link launchKwargsForChannel}.
 */
const CHANNEL_TO_PLAYWRIGHT: Readonly<Record<Channel, string>> = {
  chromium: 'chromium',
  chrome: 'chrome',
  edge: 'msedge',
};

/** The launch fields a channel decides. */
export interface LaunchKwargs {
  /** Forward to `playwright.chromium.launch({...})`. */
  readonly headless: boolean;
  /** Playwright `channel`. Always set today (`chromium`/`chrome`/`msedge`); `undefined` reserved. */
  readonly channel?: string;
  /** Extra `--flag` style args. Empty unless `incognito` adds `--incognito` for branded channels. */
  readonly args?: readonly string[];
}

/**
 * Translate the public `(channel, incognito, headless)` triple into the kwargs we hand to
 * `playwright.chromium.launch(...)`.
 *
 * `incognito` only adds `--incognito` for branded Chrome / Edge. For the `chromium` channel it is
 * skipped: BrowserHive's per-session isolation already comes from a fresh `newContext()` (memory) or
 * a managed `userDataDir` (persistent), and `--incognito` conflicts with a `--user-data-dir` anyway.
 *
 * @throws `UNKNOWN_CHANNEL` for a name outside {@link SUPPORTED_CHANNELS}.
 */
export function launchKwargsForChannel(
  channel: string,
  options: { readonly incognito: boolean; readonly headless: boolean },
): LaunchKwargs {
  if (!isChannel(channel)) {
    throw new AppError(
      'UNKNOWN_CHANNEL',
      { channel, supported: [...SUPPORTED_CHANNELS] },
      {
        // Stable public text: agents and clients may match on it, so keep it exact.
        publicMessage: `Unknown browser channel '${channel}'. Expected one of: chromium, chrome, edge.`,
      },
    );
  }

  const incognitoArgs =
    options.incognito && (channel === 'chrome' || channel === 'edge') ? ['--incognito'] : undefined;

  return {
    headless: options.headless,
    channel: CHANNEL_TO_PLAYWRIGHT[channel],
    ...(incognitoArgs !== undefined && { args: incognitoArgs }),
  };
}

/** Type guard for {@link Channel}. */
export function isChannel(value: string): value is Channel {
  return Channel.safeParse(value).success;
}
