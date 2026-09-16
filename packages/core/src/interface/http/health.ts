/** @module interface/http/health — `/health`: unauthenticated, phase-driven readiness (spec 03 §4.1). */

import type { HealthResponse } from '@browserhive/contracts/http';
import type { z } from 'zod';
import type { HealthProbe, SystemFacts } from './services.ts';

/** The health body and its status (200 only when `ready`). */
export function healthOf(
  probe: HealthProbe,
  facts: Pick<SystemFacts, 'version' | 'startedAt'>,
  now: number,
): { status: 200 | 503; body: z.input<typeof HealthResponse> } {
  const snapshot = probe.snapshot();
  return {
    status: snapshot.status === 'ready' ? 200 : 503,
    body: {
      status: snapshot.status,
      phase: snapshot.phase,
      version: facts.version,
      uptime_ms: Math.max(0, now - facts.startedAt),
      checks: { ...snapshot.checks },
    },
  };
}
