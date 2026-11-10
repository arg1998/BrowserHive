/** @module composition/phases/build-domain — phase 4: clock/ids/bus, degradations, sessions, operators, vault, auth (seed flow), notifications, schedulers, startup reconcile, tools. */
import type { Logger } from '@browserhive/core/runtime';
import { findReservedSubjects } from '@browserhive/core/runtime';
import { type BootContext } from '../context.ts';
import type { PhaseHandle } from '../unwind.ts';
/** How often expired auth sessions, grants and rate buckets are swept. */
export declare const AUTH_SWEEP_INTERVAL_MS: number;
/** Notification screenshots are kept this long (retries last at most 24 h, D-34). */
export declare const IMAGE_KEEP_MS: number;
/** How often old notification screenshots are pruned. */
export declare const IMAGE_PRUNE_INTERVAL_MS: number;
/** Phase `build-domain`. Stop drains sessions (the 15 s budget) and settles operator requests. */
export declare function buildDomainPhase(ctx: BootContext): Promise<PhaseHandle>;
/**
 * Spec 13 T0f: tokens issued before token creation refused reserved subjects keep working, so say
 * so once per boot, naming them, and let the operator revoke them. Nothing is revoked here. A
 * failed listing never fails the boot.
 */
export declare function warnReservedSubjects(
  logger: Logger,
  auth: {
    listTokens: () => Promise<Parameters<typeof findReservedSubjects>[0]>;
  },
  authTokens: readonly string[],
): Promise<void>;
//# sourceMappingURL=build-domain.d.ts.map
