/** @module composition/phases/resolve-config — phase 1: the config arrives resolved; this phase asserts it is frozen and emits the startup diagnostics once a logger exists. */
import type { ResolvedConfigBundle } from '@browserhive/core/config';
import type { Logger } from '@browserhive/core/runtime';
import type { BootContext } from '../context.ts';
import type { PhaseHandle } from '../unwind.ts';
/** Deep-freezes a value in place (the resolver already freezes; this makes the invariant local). */
export declare function deepFreeze<T>(value: T): T;
/** Phase `resolve-config`: nothing to open, nothing to stop. */
export declare function resolveConfigPhase(ctx: BootContext): Promise<PhaseHandle>;
/**
 * Logs the shadow lines (spec 08 §1: one `info` line per key supplied by several sources) and the
 * resolver's warnings. Called by the observability phase right after the logger is built.
 */
export declare function logConfigDiagnostics(logger: Logger, resolved: ResolvedConfigBundle): void;
//# sourceMappingURL=resolve-config.d.ts.map
