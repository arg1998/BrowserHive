/** @module ports/proxy-resolver — reserved proxy seam (D-13): BYO pass-through today, managed pool later. */

import type { ProxySpec } from './browser-driver.ts';

/** Input to a proxy resolution: what the caller asked for. */
export interface ProxyRequest {
  readonly sessionId: string;
  /** Caller-supplied proxy from launch/context options or raw args, if any. */
  readonly requested: ProxySpec | null;
}

/** Decides which proxy a session launches with. The default implementation passes BYO through with a forced loopback/RFC1918 bypass. */
export interface ProxyResolver {
  resolve(request: ProxyRequest): Promise<ProxySpec | null>;
}
