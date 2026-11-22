/** @module kernel/deny-list — Chromium launch-arg deny list and `UNSAFE_LAUNCH_ARG` classification. */

import { AppError } from './errors/app-error.ts';
import { err, ok, type Result } from './result.ts';

/**
 * Chromium launch-arg deny-list.
 *
 * `launch_session` accepts a typed pass-through for Playwright `LaunchOptions`, including
 * `args[]`. Some Chromium flags would silently break the guarantees BrowserHive exists to
 * provide — session isolation, the managed data-dir, and the closed remote-debugging surface —
 * so any launch that requests one is rejected up front with `UNSAFE_LAUNCH_ARG` before a browser
 * is ever spawned.
 *
 * The check is on the *switch name* Chromium would read from each arg, computed by
 * {@link launchArgKey} the way Chromium's own parser decides what a switch is, so every spelling
 * Chromium accepts (`--no-sandbox`, `-no-sandbox`, `/no-sandbox`, `--NO-SANDBOX`,
 * `-user-data-dir=/tmp/x`) is refused, not only the `--` one.
 *
 * Categories:
 * - **Isolation breakers** — sharing a profile dir, disabling the sandbox, or turning off
 *   web-security / site-isolation lets one session observe or corrupt another.
 * - **Managed-surface hijackers** — `--user-data-dir` collides with the managed persistence
 *   dir (also enforced structurally by the managed-profile guard); the remote-debugging flags
 *   would open an unauthenticated control channel into the browser that bypasses the MCP surface.
 *
 * This list is the single source of truth for the deny-list (spec 11 §10: contents must not change).
 * Entries are written in the canonical `--name` form that {@link launchArgKey} returns.
 */
export const DENIED_LAUNCH_ARG_KEYS: readonly string[] = [
  // --- Profile / data-dir collision (also structurally enforced by the managed-profile guard) ---
  '--user-data-dir',
  '--profile-directory',
  '--disk-cache-dir',
  // --- Sandbox / isolation breakers ---
  '--no-sandbox',
  '--disable-setuid-sandbox',
  '--disable-web-security',
  '--disable-site-isolation-trials',
  '--disable-features', // commonly used to switch off IsolateOrigins,site-per-process
  '--single-process',
  '--no-zygote',
  // --- Remote-debugging control-channel exposure ---
  '--remote-debugging-port',
  '--remote-debugging-pipe',
  '--remote-debugging-address',
];

/**
 * The prefixes Chromium's command-line parser accepts for a switch, longest first
 * (`base/command_line.cc` `kSwitchPrefixes`): `--` and `-` everywhere, and `/` on Windows. `/` is
 * treated as a prefix on every platform: refusing a POSIX path that happens to spell a denied
 * switch costs nothing (Playwright rejects args that do not start with `-` anyway), while missing a
 * Windows switch would open the hole the deny-list exists to close.
 */
export const LAUNCH_ARG_SWITCH_PREFIXES: readonly string[] = ['--', '-', '/'];

/**
 * Chromium's end-of-switches marker (`kSwitchTerminator`): every arg after a bare `--` is a
 * non-switch argument. A bare `--` in `launch_options.args` is refused outright: it is never needed
 * (Playwright opens pages itself) and it would turn the switches Playwright appends after the
 * caller's args into page arguments.
 */
export const LAUNCH_ARG_SWITCH_TERMINATOR = '--';

/** Fast lookup set built once from {@link DENIED_LAUNCH_ARG_KEYS}. */
const DENIED_SET: ReadonlySet<string> = new Set(DENIED_LAUNCH_ARG_KEYS.map(asciiLowerCase));

/**
 * Whitespace Chromium trims from each arg before parsing it: ASCII whitespace on POSIX and Unicode
 * whitespace on Windows. JavaScript's `\s` covers both except U+0085 (NEXT LINE), added here.
 */
const SURROUNDING_WHITESPACE = /^[\s\u0085]+|[\s\u0085]+$/g;

function trimArg(arg: string): string {
  return arg.replace(SURROUNDING_WHITESPACE, '');
}

/** Lowercases A–Z only, like Chromium's `ToLowerASCII` (switch names are case-insensitive on Windows). */
function asciiLowerCase(value: string): string {
  return value.replace(/[A-Z]/g, (c) => c.toLowerCase());
}

/**
 * Normalises a raw launch arg to the switch Chromium would read from it, in canonical `--name`
 * form, or `null` when Chromium would not treat the arg as a switch at all.
 *
 * Mirrors `IsSwitch` in Chromium's `base/command_line.cc`: the arg is trimmed, must start with a
 * {@link LAUNCH_ARG_SWITCH_PREFIXES switch prefix} followed by at least one character, and the name
 * is what sits between the prefix and the first `=`. The name is then trimmed and lowercased, so
 * case variants (accepted by Chromium on Windows) and stray inner whitespace never slip past a
 * comparison. `'  -User-Data-Dir=/tmp/x '` → `'--user-data-dir'`; `'https://example.com'` → `null`.
 */
export function launchArgKey(arg: string): string | null {
  const trimmed = trimArg(arg);
  const prefix = LAUNCH_ARG_SWITCH_PREFIXES.find((p) => trimmed.startsWith(p));
  if (prefix === undefined || prefix.length === trimmed.length) return null;
  const eq = trimmed.indexOf('=');
  const name = trimmed.slice(prefix.length, eq === -1 ? undefined : eq);
  return `--${asciiLowerCase(trimArg(name))}`;
}

/** True if `arg` is on the deny-list in any spelling Chromium accepts, or is a bare `--`. */
export function isDeniedLaunchArg(arg: string): boolean {
  if (trimArg(arg) === LAUNCH_ARG_SWITCH_TERMINATOR) return true;
  const key = launchArgKey(arg);
  return key !== null && DENIED_SET.has(key);
}

/** Details of an `UNSAFE_LAUNCH_ARG` failure: the original, un-normalised arg. */
export interface UnsafeLaunchArgDetails {
  readonly arg: string;
}

/**
 * Classifies a launch-arg list: `Ok` when every entry is allowed, `Err` naming the first denied
 * entry (verbatim, so the message is faithful to what the caller passed).
 */
export function classifyLaunchArgs(
  args: readonly string[] | undefined,
): Result<readonly string[], UnsafeLaunchArgDetails> {
  if (args === undefined) return ok([]);
  for (const arg of args) {
    if (isDeniedLaunchArg(arg)) return err({ arg });
  }
  return ok(args);
}

/**
 * Asserts that none of `args` are deny-listed. No-op for `undefined` / empty input. Called by the
 * launch path *before* any browser process is spawned, so a rejected launch has zero side effects.
 *
 * @throws `UNSAFE_LAUNCH_ARG` with `{ arg }` for the first offending entry.
 */
export function assertLaunchArgsAllowed(args: readonly string[] | undefined): void {
  const result = classifyLaunchArgs(args);
  if (!result.ok) {
    throw new AppError(
      'UNSAFE_LAUNCH_ARG',
      { arg: result.error.arg },
      {
        // Stable public text: agents may match on it.
        publicMessage: `Launch arg '${result.error.arg}' is on the deny-list and would break session isolation.`,
      },
    );
  }
}
