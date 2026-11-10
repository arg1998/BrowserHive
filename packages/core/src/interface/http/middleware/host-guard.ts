/** @module interface/http/middleware/host-guard — middleware 4: DNS-rebinding defense via a `Host` allow-list (spec 03 §2). */

import type { MiddlewareHandler } from 'hono';
import { AppError } from '../../../kernel/errors/app-error.ts';
import {
  isCanonicalLoopback,
  isLoopbackByMeaning,
  TEMPLATE_HOST_COOKIE,
} from '../../../kernel/self-address.ts';
import { isIpLiteral } from '../../../kernel/url.ts';
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
 * True when `hostname` may address this server: the canonical loopback names (`localhost`,
 * `127.0.0.1`, `::1`), the configured host, extra `allowedHosts`, and — only for a wildcard bind —
 * any IP literal that is not a loopback alias (a DNS name can be rebound; an IP cannot). Loopback
 * aliases (`foo.localhost`, `127.0.0.2`, `::ffff:127.0.0.1`) are refused: no cookie can be scoped to
 * them, so a template browser's marker could not reach the daemon through them (spec 13 §3.8).
 */
export function isHostAllowed(
  hostname: string,
  config: { readonly host: string; readonly allowedHosts?: readonly string[] },
): boolean {
  const name = hostname.replace(/^\[|\]$/g, '');
  if (isCanonicalLoopback(name)) return true;
  const bound = config.host.toLowerCase().replace(/^\[|\]$/g, '');
  if (name === bound) return true;
  if ((config.allowedHosts ?? []).some((h) => hostnameOf(h) === name)) return true;
  return WILDCARD_BINDS.has(bound) && isIpLiteral(name) && !isLoopbackByMeaning(name);
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

/** True when a `Cookie` header carries the template-host marker (spec 13 §3.8). */
export function fromTemplateHost(cookieHeader: string | undefined): boolean {
  if (cookieHeader === undefined) return false;
  return cookieHeader.split(';').some((part) => part.trim().startsWith(`${TEMPLATE_HOST_COOKIE}=`));
}

/**
 * Refuses every request a template browser makes (it carries the marker cookie the host sets for
 * BrowserHive's own origins) with 403 `ORIGIN_NOT_ALLOWED`, before any route serves the dashboard,
 * the API or a login page: the template host's own route never sees a redirect hop.
 */
export function templateHostGuard(): MiddlewareHandler<HttpEnv> {
  return async (c, next) => {
    if (fromTemplateHost(c.req.header('cookie'))) {
      throw new AppError(
        'ORIGIN_NOT_ALLOWED',
        {},
        { message: 'request from a session template browser refused' },
      );
    }
    await next();
  };
}
