/** @module infra/browsers/driver-support — pieces of the browser driver that need no browser: the default sandbox policy, the display half recorded on metadata, and a Chromium session's engine capabilities (spec 11 §2.1, §4.1). */

import type { BrowserType } from 'patchright';
import type { AppliedDisplay, EngineCapabilities, LaunchSpec } from '../../ports/browser-driver.ts';
import type { Clock } from '../../ports/clock.ts';
import type { Logger } from '../../ports/logger.ts';
import { channelExecutable } from './browser-detection.ts';
import { sandboxUnavailable } from './sandbox-error.ts';
import { SandboxPolicy } from './sandbox-policy.ts';

/** What an agent is told when nothing better is known about this host. */
export const ASK_OPERATOR_GUIDANCE: readonly string[] = [
  "Ask the operator to run 'browserhive doctor' for the options on this host.",
  'Or launch without launch_options.chromiumSandbox.',
];

/** The `off` policy used when none is configured: required sandboxes still fail typed. */
export function defaultSandboxPolicy(deps: {
  readonly logger: Logger;
  readonly clock: Clock;
}): SandboxPolicy {
  return new SandboxPolicy({
    mode: 'off',
    root: false,
    logger: deps.logger,
    clock: deps.clock,
    unavailable: ({ target, reason, requiredBy, err }) =>
      sandboxUnavailable({
        channel: target.channel,
        reason,
        requiredBy,
        alternatives: [],
        guidance: [...ASK_OPERATOR_GUIDANCE],
        ...(err !== undefined && { err }),
      }),
  });
}

/** Only record the display half when it was actually asserted, so metadata never claims a geometry the page was not given. */
export function displayFor(spec: LaunchSpec): AppliedDisplay | null {
  const identity = spec.identity;
  if (identity === undefined || !identity.assertDisplay) return null;
  const fp = identity.fingerprint;
  return {
    screen: { width: fp.screen.width, height: fp.screen.height },
    viewport: { ...fp.viewport },
    deviceScaleFactor: fp.deviceScaleFactor,
  };
}

/** Engine capabilities of a Chromium session on Patchright, the only driver (spec 11 §2.1, D-65). */
export function capabilitiesFor(spec: Pick<LaunchSpec, 'headless'>): EngineCapabilities {
  return {
    cdpScreencast: true,
    // Chromium can only print to PDF in headless mode.
    pdf: spec.headless,
    trace: true,
    closedShadowRoot: true,
    perContextProxy: true,
    // Patchright's isolated-world `evaluate` needs the `isolatedContext: false` argument.
    isolatedEvaluate: true,
  };
}

/** The executable `channel` launches on this host (the sandbox policy's cache key), or `null`. */
export function executableOf(
  browserType: Pick<BrowserType, 'executablePath'>,
  channel: LaunchSpec['channel'],
  locate: (playwrightChannel: 'chrome' | 'msedge') => string | null,
): string | null {
  return channelExecutable(
    channel,
    () => {
      try {
        const path = browserType.executablePath();
        return path === '' ? null : path;
      } catch {
        return null;
      }
    },
    locate,
  );
}
