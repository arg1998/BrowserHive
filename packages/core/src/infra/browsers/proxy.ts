/** @module infra/browsers/proxy — the reserved proxy seam's only implementation: BYO pass-through with a forced loopback/RFC1918 bypass (D-13, spec 11 §11). */

import type { ProxySpec } from '../../ports/browser-driver.ts';
import type { ProxyRequest, ProxyResolver } from '../../ports/proxy-resolver.ts';

/**
 * Hosts that must never tunnel through a session's proxy: the dashboard's CDP/screencast, local
 * fixtures and anything else on the operator's own machine or LAN. Unioned with the caller's own
 * `bypass` so a BYO proxy can never accidentally capture loopback traffic.
 */
export const FORCED_PROXY_BYPASS: readonly string[] = [
  'localhost',
  '127.0.0.0/8',
  '::1',
  '10.0.0.0/8',
  '172.16.0.0/12',
  '192.168.0.0/16',
  '*.local',
];

/**
 * Union the forced bypass list with a caller's comma/semicolon-separated Chromium bypass string,
 * de-duplicated and order-preserving (forced entries first).
 */
export function mergeBypass(callerBypass: string | undefined): string {
  const seen = new Set<string>();
  const out: string[] = [];
  const add = (entry: string): void => {
    const trimmed = entry.trim();
    if (trimmed.length === 0 || seen.has(trimmed.toLowerCase())) return;
    seen.add(trimmed.toLowerCase());
    out.push(trimmed);
  };
  for (const entry of FORCED_PROXY_BYPASS) add(entry);
  for (const entry of (callerBypass ?? '').split(/[,;]/)) add(entry);
  return out.join(',');
}

/**
 * Default {@link ProxyResolver}: passes the caller's proxy through unchanged except for the forced
 * bypass list. Returns `null` when no proxy was requested. A managed pool (Tier 1) replaces this
 * class without touching the stealth modules.
 */
export class PassThroughProxyResolver implements ProxyResolver {
  resolve(request: ProxyRequest): Promise<ProxySpec | null> {
    const requested = request.requested;
    if (requested === null) return Promise.resolve(null);
    return Promise.resolve({
      ...requested,
      bypass: mergeBypass(requested.bypass),
      source: requested.source ?? 'byo',
    });
  }
}
