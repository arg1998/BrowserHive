/** @module interface/http/middleware/origin-guard — middleware 5: CSRF guard on mutating requests and WS upgrades (spec 03 §2). */

import type { MiddlewareHandler } from 'hono';
import { AppError } from '../../../kernel/errors/app-error.ts';
import { isLoopbackHost } from '../../../kernel/url.ts';
import type { HttpEnv } from '../env.ts';
import { hostnameOf } from './host-guard.ts';

const MUTATING: ReadonlySet<string> = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

function portOf(hostHeader: string, fallback: string): string {
  const match = /^(?:\[[^\]]+\]|[^:]+)(?::(\d+))?$/.exec(hostHeader.trim());
  return match?.[1] ?? fallback;
}

/**
 * True when a browser `Origin` addresses the same server as `Host`: identical `host:port`, or both
 * loopback aliases with equal ports (so `localhost` and `127.0.0.1` count as the same origin).
 */
export function isSameOrigin(origin: string, host: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
  if (parsed.host.toLowerCase() === host.toLowerCase()) return true;
  const originPort = parsed.port !== '' ? parsed.port : parsed.protocol === 'https:' ? '443' : '80';
  const hostPort = portOf(host, '80');
  return (
    isLoopbackHost(parsed.hostname.replace(/^\[|\]$/g, '')) &&
    isLoopbackHost(hostnameOf(host)) &&
    originPort === hostPort
  );
}

/**
 * On mutating methods and WS upgrades: `Origin` must be same-origin, or `Sec-Fetch-Site` must be
 * `same-origin`/`none`. Without either header the request is allowed only when it carries no
 * ambient cookie credential (a bearer or anonymous non-browser client cannot be forged cross-site).
 */
export function originGuard(): MiddlewareHandler<HttpEnv> {
  return async (c, next) => {
    const upgrade = c.req.header('upgrade')?.toLowerCase() === 'websocket';
    if (!MUTATING.has(c.req.method) && !upgrade) return next();
    const host = c.req.header('host') ?? new URL(c.req.url).host;
    const origin = c.req.header('origin');
    const fetchSite = c.req.header('sec-fetch-site');
    let allowed: boolean;
    if (origin !== undefined) allowed = isSameOrigin(origin, host);
    else if (fetchSite !== undefined) allowed = fetchSite === 'same-origin' || fetchSite === 'none';
    else allowed = c.req.header('cookie') === undefined;
    if (!allowed) {
      throw new AppError(
        'ORIGIN_NOT_ALLOWED',
        {},
        { message: `origin ${origin ?? 'none'} refused` },
      );
    }
    return next();
  };
}
