/** @module composition/phases/listeners-http — the http front door: realtime hub, `Bun.serve` on host/port (port 0 supported), MCP Streamable HTTP handler and the Hono app on one port (D-02). */
import { AppError } from '@browserhive/core/runtime';
import type { OperatorRequestBroker, Realtime } from '@browserhive/core/server';
import { type BootContext } from '../context.ts';
import type { PhaseHandle } from '../unwind.ts';
/** Housekeeping interval of the HTTP rate-limit buckets. */
export declare const HTTP_SWEEP_INTERVAL_MS = 60000;
/** The `Bun.serve` seam (tests inject a throwing or fake server). */
export type ServeFn = (options: {
  readonly hostname: string;
  readonly port: number;
  readonly fetch: (request: Request, server: unknown) => Response | Promise<Response>;
  readonly websocket: Realtime['websocket'];
}) => {
  readonly port: number | undefined;
  stop(closeActiveConnections?: boolean): unknown;
};
/** Production `Bun.serve`. */
export declare const bunServe: ServeFn;
/** Maps a listen failure onto `PORT_IN_USE` (exit 3) or `BIND_FAILED` (exit 1). */
export declare function bindError(err: unknown, host: string, port: number): AppError;
/** URL authority for a host (IPv6 literals in brackets). */
export declare function urlFor(host: string, port: number): string;
/**
 * Cancels the open attention requests of a principal whose last MCP session closed (spec 02 §1.2);
 * an agent that reconnects on another session keeps its requests.
 */
export declare function cancelAttentionOf(
  broker: Pick<OperatorRequestBroker, 'listOpen' | 'cancel'>,
  subject: string,
): Promise<number>;
/** Opens the http listener. */
export declare function openHttpListener(ctx: BootContext, serve?: ServeFn): Promise<PhaseHandle>;
//# sourceMappingURL=listeners-http.d.ts.map
