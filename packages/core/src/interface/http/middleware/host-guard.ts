/** @module interface/http/middleware/host-guard — middleware 4: DNS-rebinding defense via a `Host` allow-list (spec 03 §2). */

import type { MiddlewareHandler } from 'hono';
import { AppError } from '../../../kernel/errors/app-error.ts';
import { isIpLiteral, isLoopbackHost } from '../../../kernel/url.ts';
import type { HttpEnv } from '../env.ts';

/** Splits `host[:port]` (IPv6 in brackets) and returns the lower-cased host name. */
export function hostnameOf(hostHeader: string): string {
  const trimmed = hostHeader.trim().toLowerCase();
  if (trimmed.startsWith('[')) {
    const end = trimmed.indexOf(']');
    return end < 0 ? trimmed : trimmed.slice(1, end);
  }
  const colon = trimmed.lastIndexOf(':');
  return colon >= 0 && trimmed.indexOf(':') === colon ? trimmed.slice(0, colon) : trimmed;
}

const WILDCARD_BINDS: ReadonlySet<string> = new Set(['0.0.0.0', '::', '']);

/**
 * True when `hostname` may address this server: loopback names, the configured host, extra
 * `allowedHosts`, and — only for a wildcard bind — any IP literal (a DNS name can be rebound; an
 * IP cannot).
 */
export function isHostAllowed(
  hostname: string,
  config: { readonly host: string; readonly allowedHosts?: readonly string[] },
): boolean {
  const name = hostname.replace(/^\[|\]$/g, '');
  if (isLoopbackHost(name)) return true;
  const bound = config.host.toLowerCase().replace(/^\[|\]$/g, '');
  if (name === bound) return true;
  if ((config.allowedHosts ?? []).some((h) => hostnameOf(h) === name)) return true;
  return WILDCARD_BINDS.has(bound) && isIpLiteral(name);
}

/** Rejects requests whose `Host` is not allowed with 421 `HOST_NOT_ALLOWED`. */
export function hostGuard(config: {
  readonly host: string;
  readonly allowedHosts?: readonly string[];
}): MiddlewareHandler<HttpEnv> {
  return async (c, next) => {
    const header = c.req.header('host') ?? new URL(c.req.url).host;
    if (!isHostAllowed(hostnameOf(header), config)) {
      throw new AppError('HOST_NOT_ALLOWED', {}, { message: `host ${header} not allowed` });
    }
    await next();
  };
}
