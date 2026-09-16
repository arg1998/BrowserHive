/** @module interface/http/env — the Hono environment (per-request variables) and the HTTP app configuration slice. */

import type { AuthMode } from '@browserhive/contracts/enums';
import type { Context } from 'hono';
import type { RequestPrincipal } from '../../domain/auth/principal.ts';

/** Per-request variables set by the middleware stack and read by the dispatcher. */
export interface HttpVariables {
  requestId: string;
  traceId: string;
  spanId: string;
  /** Client IP after trusted-proxy resolution; `'unknown'` when the transport gave none. */
  clientIp: string;
  /** True when the client IP is a loopback address. */
  remoteLoopback: boolean;
  /** True when the request arrived over TLS via a trusted proxy. */
  secure: boolean;
  /** CSP nonce minted per response. */
  nonce: string;
  /** Authenticated caller; `null` until `authenticate` ran or on public routes. */
  principal: RequestPrincipal | null;
  /** Operation id of the matched route (set by the dispatcher for logs/spans). */
  operationId: string | undefined;
}

/** Hono env of the admin app. */
export type HttpEnv = { Variables: HttpVariables };

/** Hono context of the admin app. */
export type HttpContext = Context<HttpEnv>;

/** The config keys the HTTP layer consumes (resolved values). */
export interface HttpAppConfig {
  readonly host: string;
  readonly port: number;
  readonly admin: boolean;
  /** `auth` mode; `token` requires a bearer on `/mcp`. */
  readonly authMode: AuthMode;
  /** Extra `Host` values accepted by the DNS-rebinding guard (in addition to loopback and `host`). */
  readonly allowedHosts?: readonly string[];
  /** CIDR list of proxies whose `X-Forwarded-*` headers are trusted. */
  readonly trustedProxies?: readonly string[];
  /** `allowInsecureBind`: serve the local MCP principal to non-loopback peers under `auth=off`. */
  readonly allowInsecureBind?: boolean;
}

/** Reads a request header case-insensitively from a Hono context. */
export function headerOf(c: HttpContext, name: string): string | undefined {
  const value = c.req.header(name);
  return value === undefined || value === '' ? undefined : value;
}

/** The slice of Bun's `Server` the interface layer uses (passed as Hono's env by `fetch`). */
export interface ServerLike {
  requestIP(request: Request): { readonly address: string } | null;
  upgrade(request: Request, options: { data: unknown; headers?: Record<string, string> }): boolean;
}

function hasMethod<K extends string>(value: unknown, key: K): value is Record<K, unknown> {
  return typeof value === 'object' && value !== null && key in value;
}

/** The Bun server behind a request, when the app runs under `Bun.serve` (absent in `app.request`). */
export function serverOf(c: HttpContext): ServerLike | undefined {
  const env: unknown = c.env;
  if (!hasMethod(env, 'upgrade') || !hasMethod(env, 'requestIP')) return undefined;
  const { upgrade, requestIP } = env;
  if (typeof upgrade !== 'function' || typeof requestIP !== 'function') return undefined;
  return {
    requestIP: (request) => {
      const result: unknown = Reflect.apply(requestIP, env, [request]);
      return hasMethod(result, 'address') && typeof result.address === 'string'
        ? { address: result.address }
        : null;
    },
    upgrade: (request, options) => Reflect.apply(upgrade, env, [request, options]) === true,
  };
}

/**
 * Lifts Bun's per-connection idle timeout (default 10 s) for one request whose response is a
 * long-lived stream. A blocked MCP tool call (`request_attention`, vault confirm) writes nothing
 * until an operator decides, and the SSE keep-alive is slower than 10 s, so without this Bun cuts
 * the stream and the eventual result is never delivered. No-op outside `Bun.serve`.
 */
export function disableIdleTimeout(c: HttpContext): void {
  const env: unknown = c.env;
  if (!hasMethod(env, 'timeout') || typeof env.timeout !== 'function') return;
  Reflect.apply(env.timeout, env, [c.req.raw, 0]);
}
