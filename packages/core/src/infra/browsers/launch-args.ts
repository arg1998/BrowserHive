/** @module infra/browsers/launch-args — stealth flags, `ignoreDefaultArgs` merge rule and the channel → stealth → user arg merge order (spec 11 §2.2). */

import type { LaunchOptions } from 'playwright';
import type { LaunchWarning, ProxySpec } from '../../ports/browser-driver.ts';
import type { LaunchKwargs } from './channel.ts';

/** Launch flag that projects `navigator.webdriver = false`. Not deny-listed; injected only for stealth. */
export const STEALTH_ARGS: readonly string[] = ['--disable-blink-features=AutomationControlled'];
/** Playwright default arg that advertises automation; suppressed for stealth sessions. */
export const AUTOMATION_ARG = '--enable-automation';

/**
 * Compute the `ignoreDefaultArgs` for a stealth launch so Playwright drops `--enable-automation`,
 * merging with any value the caller already passed:
 *   - `true` (ignore ALL defaults) → left as-is; `--enable-automation` is already gone.
 *   - an array → `--enable-automation` appended if not present.
 *   - absent → `['--enable-automation']`.
 */
export function mergeIgnoreDefaultArgs(
  userValue: readonly string[] | boolean | undefined,
): string[] | boolean {
  if (userValue === true) return true;
  const base = Array.isArray(userValue) ? [...userValue] : [];
  return base.includes(AUTOMATION_ARG) ? base : [...base, AUTOMATION_ARG];
}

/** Inputs to {@link buildLaunchOptions}. */
export interface BuildLaunchOptionsInput {
  readonly kwargs: LaunchKwargs;
  readonly stealth: boolean;
  readonly launchOptions: LaunchOptions | undefined;
  /** The resolved first-class proxy (D-13); applied as Playwright's `proxy` option. */
  readonly proxy: ProxySpec | null;
  /** Session-scoped downloads directory (never user-supplied; the user field is refused). */
  readonly downloadsDir: string;
}

/** The merged options shared by `launch()` and `launchPersistentContext()`. */
export interface BuiltLaunchOptions {
  readonly options: LaunchOptions;
  /** True when the caller overrode the binary, which disables channel routing. */
  readonly hasExecutablePath: boolean;
}

/**
 * Separate the fields BrowserHive controls (`headless`, `channel`, `args`) from the rest of the
 * user's `LaunchOptions` pass-through. The controlled fields win; args are merged in the order
 * channel args → stealth args → user args (so a user override still wins where the deny-list
 * permits it, and the internally-injected stealth arg is never deny-checked).
 */
export function buildLaunchOptions(input: BuildLaunchOptionsInput): BuiltLaunchOptions {
  const {
    args: userArgs,
    headless: _headless,
    channel: _channel,
    ...restLaunchOptions
  } = input.launchOptions ?? {};
  const stealthArgs = input.stealth ? [...STEALTH_ARGS] : [];
  const mergedArgs = [...(input.kwargs.args ?? []), ...stealthArgs, ...(userArgs ?? [])];

  // When the caller overrides `executablePath`, channel routing no longer applies: a
  // named channel and an explicit binary conflict, so the explicit binary wins.
  const hasExecutablePath = restLaunchOptions.executablePath !== undefined;

  const options: LaunchOptions = {
    ...restLaunchOptions,
    headless: input.kwargs.headless,
    ...(input.kwargs.channel !== undefined &&
      !hasExecutablePath && {
        channel: input.kwargs.channel,
      }),
    // Suppress Playwright's default `--enable-automation` for stealth sessions (it can't be
    // removed by omitting an arg — it's a *default* arg). Merge with any user-supplied value.
    ...(input.stealth && {
      ignoreDefaultArgs: mergeIgnoreDefaultArgs(restLaunchOptions.ignoreDefaultArgs),
    }),
    ...(mergedArgs.length > 0 && { args: mergedArgs }),
    // The typed proxy (BYO normalised upstream, with the forced loopback bypass) replaces any raw
    // `proxy` that rode in through the pass-through, so there is exactly one owner of egress.
    ...(input.proxy !== null && { proxy: playwrightProxyFor(input.proxy) }),
    downloadsPath: input.downloadsDir,
  };

  return { options, hasExecutablePath };
}

/** Playwright's `proxy` option shape from a {@link ProxySpec} (label and source are metadata only). */
export function playwrightProxyFor(proxy: ProxySpec): NonNullable<LaunchOptions['proxy']> {
  return {
    server: proxy.server,
    ...(proxy.bypass !== undefined && { bypass: proxy.bypass }),
    ...(proxy.username !== undefined && { username: proxy.username }),
    ...(proxy.password !== undefined && { password: proxy.password }),
  };
}

/** The `EXECUTABLE_PATH_OVERRIDE` warning (stable public text), emitted once per launch that overrides the binary. */
export function executablePathWarning(executablePath: string, channel: string): LaunchWarning {
  return {
    code: 'EXECUTABLE_PATH_OVERRIDE',
    message: 'executablePath overrides the browser binary; channel routing no longer applies',
    details: { executablePath, channel },
  };
}
