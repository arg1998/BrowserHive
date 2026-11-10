/** @module composition/phases/listeners-stdio — the stdio front door: one `McpServer` over the SDK stdio transport, principal `local`; the process stops when the client goes away (D-02). */
import { type BootContext } from '../context.ts';
import type { PhaseHandle } from '../unwind.ts';
/** Opens the stdio transport. Only JSON-RPC frames are ever written to `stdout`. */
export declare function openStdioListener(ctx: BootContext): Promise<PhaseHandle>;
//# sourceMappingURL=listeners-stdio.d.ts.map
