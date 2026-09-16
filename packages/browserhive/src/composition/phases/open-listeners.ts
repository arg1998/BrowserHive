/** @module composition/phases/open-listeners — phase 6: the http listener (Bun.serve) or the stdio transport, never both (D-02). */

import type { BootContext } from '../context.ts';
import type { PhaseHandle } from '../unwind.ts';
import { bunServe, openHttpListener, type ServeFn } from './listeners-http.ts';
import { openStdioListener } from './listeners-stdio.ts';

/** Phase `open-listeners`. */
export async function openListenersPhase(
  ctx: BootContext,
  serve: ServeFn = bunServe,
): Promise<PhaseHandle> {
  ctx.health.enter('open-listeners');
  return ctx.transport === 'http' ? openHttpListener(ctx, serve) : openStdioListener(ctx);
}
