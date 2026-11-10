/** @module composition/phases/wire-observers — phase 5: recorder projection, notification producers, system status publisher, maintenance schedulers, lease sweeper, OTel metrics consumers. */
import { type BootContext } from '../context.ts';
import type { PhaseHandle } from '../unwind.ts';
/** Version of the optional `patchright` package, or `null` when it cannot be resolved. */
export declare function patchrightVersion(): string | null;
/** Phase `wire-observers`. */
export declare function wireObserversPhase(ctx: BootContext): Promise<PhaseHandle>;
//# sourceMappingURL=wire-observers.d.ts.map
