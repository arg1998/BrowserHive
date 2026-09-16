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
 * The check is on the *key* of each arg (the part before `=`), so `--no-sandbox`,
 * `--js-flags=--foo`, and `--user-data-dir=/tmp/x` are all normalised to their flag name first.
 * Matching is case-sensitive (Chromium flags are lowercase) and leading whitespace is trimmed.
 *
 * Categories:
 * - **Isolation breakers** — sharing a profile dir, disabling the sandbox, or turning off
 *   web-security / site-isolation lets one session observe or corrupt another.
 * - **Managed-surface hijackers** — `--user-data-dir` collides with the managed persistence
 *   dir (also enforced structurally by the managed-profile guard); the remote-debugging flags
 *   would open an unauthenticated control channel into the browser that bypasses the MCP surface.
 *
 * This list is the single source of truth for the deny-list (spec 11 §10: contents must not change).
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

/** Fast lookup set built once from {@link DENIED_LAUNCH_ARG_KEYS}. */
const DENIED_SET: ReadonlySet<string> = new Set(DENIED_LAUNCH_ARG_KEYS);

/**
 * Normalises a raw launch arg to its flag *key*: trims surrounding whitespace and drops any
 * `=value` suffix. `'  --user-data-dir=/tmp/x '` → `'--user-data-dir'`.
 */
export function launchArgKey(arg: string): string {
  const trimmed = arg.trim();
  const eq = trimmed.indexOf('=');
  return eq === -1 ? trimmed : trimmed.slice(0, eq);
}

/** True if `arg` is on the deny-list. */
export function isDeniedLaunchArg(arg: string): boolean {
  return DENIED_SET.has(launchArgKey(arg));
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
