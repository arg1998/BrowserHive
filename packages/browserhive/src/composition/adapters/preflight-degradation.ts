/** @module composition/adapters/preflight-degradation — reports the `PREFLIGHTS_NOT_ENFORCED` degradation when routed browsers cannot send real CORS preflights (D-66). */

import type { DegradationReporter } from '@browserhive/core/runtime';
import type { PreflightEnforcement } from '@browserhive/core/server';

/** Where the enforcement state comes from (the core's `onPreflightRefusal`/`verifyPreflightDriver`). */
export interface PreflightEnforcementSource {
  /** Checks the driver version now; refuses enforcement when it is not verified. */
  verify(): PreflightEnforcement;
  /** Calls the listener when enforcement is refused (at once when it already is). */
  onRefusal(listener: (enforcement: PreflightEnforcement) => void): () => void;
}

/**
 * Checks the driver at boot and reports a refusal, whenever it happens, as one `error`
 * degradation, so the operator sees it on the System page and in `/system` before (or as soon as)
 * a routed browser starts refusing cross-origin requests that need a preflight.
 *
 * @returns Stops listening.
 */
export function wirePreflightDegradation(
  degradations: DegradationReporter,
  source: PreflightEnforcementSource,
): () => void {
  const stop = source.onRefusal((enforcement) => {
    degradations.report({
      code: 'PREFLIGHTS_NOT_ENFORCED',
      severity: 'error',
      message:
        'Routed browsers cannot send real CORS preflights; they refuse cross-origin requests that need one.',
      details: {
        reason: enforcement.reason ?? 'driver_shape',
        driver_version: enforcement.driverVersion,
      },
    });
  });
  source.verify();
  return stop;
}
