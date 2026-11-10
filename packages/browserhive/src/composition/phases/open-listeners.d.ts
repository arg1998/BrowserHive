/** @module composition/phases/open-listeners — phase 6: the http listener (Bun.serve) or the stdio transport, never both (D-02). */
import type { BootContext } from '../context.ts';
import type { PhaseHandle } from '../unwind.ts';
import { type ServeFn } from './listeners-http.ts';
/** Phase `open-listeners`. */
export declare function openListenersPhase(ctx: BootContext, serve?: ServeFn): Promise<PhaseHandle>;
//# sourceMappingURL=open-listeners.d.ts.map
