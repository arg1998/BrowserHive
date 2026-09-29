/** @module app/notifications/public-url — the `publicUrl` check (spec 08 §5.8, D-37): fetch `<publicUrl>/health` and tell whether it reaches this BrowserHive, another server, a login in front, or nothing; plus the host/origin trust helpers. */

import type { PublicUrlOutcome, PublicUrlStatus } from '@browserhive/contracts/http';
import { serializeError } from '../../kernel/errors/serialize-error.ts';
import { isLoopbackHost } from '../../kernel/url.ts';
import type { Clock } from '../../ports/clock.ts';
import type { UrlProbe, UrlProbeResult } from '../../ports/notification-channel.ts';

/** Timeout of one probe. */
export const PUBLIC_URL_PROBE_TIMEOUT_MS = 5_000;
/** How long a check result is reused. */
export const PUBLIC_URL_CACHE_MS = 60_000;

/** Outcome of classifying one probe. */
export interface PublicUrlVerdict {
  readonly outcome: Exclude<PublicUrlOutcome, 'unset'>;
  readonly detail: string;
  readonly statusCode: number | null;
  /** A BrowserHive answered, whether or not it could be confirmed as this one. */
  readonly browserhive: boolean;
}

function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.replace(/^\[|\]$/g, '').toLowerCase();
  } catch {
    return null;
  }
}

/**
 * The host of `publicUrl` (the name the `Host` guard and `/mcp` must accept), or `null` when unset.
 *
 * @returns The lower-cased host name without brackets.
 */
export function publicUrlHost(publicUrl: string | undefined): string | null {
  return publicUrl === undefined ? null : hostOf(publicUrl);
}

/**
 * The origin of `publicUrl` (`https://bh.example.net`, the origin guard's extra same origin).
 *
 * @returns The origin, or `null` when unset.
 */
export function publicUrlOrigin(publicUrl: string | undefined): string | null {
  if (publicUrl === undefined) return null;
  try {
    return new URL(publicUrl).origin;
  } catch {
    return null;
  }
}

/**
 * Whether `publicUrl` is plain `http:` on a host that is not loopback (links would travel without
 * TLS, spec 08 §5.8).
 */
export function isInsecurePublicUrl(publicUrl: string | undefined): boolean {
  if (publicUrl === undefined || !publicUrl.toLowerCase().startsWith('http:')) return false;
  const host = hostOf(publicUrl);
  return host !== null && !isLoopbackHost(host);
}

function parseHealth(body: string): { readonly instanceId: string | null; readonly isBh: boolean } {
  try {
    const json: unknown = JSON.parse(body);
    if (typeof json !== 'object' || json === null) return { instanceId: null, isBh: false };
    const record = json as Record<string, unknown>;
    const isBh = typeof record['version'] === 'string' && typeof record['status'] === 'string';
    const id = record['instance_id'];
    return { instanceId: typeof id === 'string' ? id : null, isBh };
  } catch {
    return { instanceId: null, isBh: false };
  }
}

/**
 * Classifies one probe of `<publicUrl>/health` against this start's `instance_id` (`null` when
 * there is no running server to compare with, as in `doctor` without a server).
 *
 * @returns The verdict.
 */
export function classifyPublicUrlProbe(
  result: UrlProbeResult,
  instanceId: string | null,
): PublicUrlVerdict {
  if (result.kind === 'error') {
    return {
      outcome: 'unreachable',
      detail: `No answer from this machine (${result.detail}). It may still work from outside, for example behind a router without hairpin NAT.`,
      statusCode: null,
      browserhive: false,
    };
  }
  const status = result.status;
  if (status >= 300 && status < 400) {
    const to = result.location === null ? null : hostOf(result.location);
    return {
      outcome: 'login',
      detail: `It redirects${to === null ? '' : ` to ${to}`}: probably a login or an access proxy in front (for example Cloudflare Access), so it cannot be confirmed from here.`,
      statusCode: status,
      browserhive: false,
    };
  }
  if (status === 401 || status === 403 || status === 407) {
    return {
      outcome: 'login',
      detail: `It answers HTTP ${status}: a login or an access proxy is in front, so it cannot be confirmed from here.`,
      statusCode: status,
      browserhive: false,
    };
  }
  const health = parseHealth(result.body);
  if (health.isBh) {
    if (instanceId === null) {
      return {
        outcome: 'ok',
        detail: 'A BrowserHive answered (start the server to confirm it is this one).',
        statusCode: status,
        browserhive: true,
      };
    }
    if (health.instanceId === instanceId) {
      return {
        outcome: 'ok',
        detail: 'It points to this BrowserHive.',
        statusCode: status,
        browserhive: true,
      };
    }
    return {
      outcome: 'elsewhere',
      detail: 'Another BrowserHive answered (a different instance, or an older version).',
      statusCode: status,
      browserhive: true,
    };
  }
  if (status === 502 || status === 503 || status === 504) {
    // A proxy answered for an upstream it cannot reach (often an error page in HTML): the address
    // is set up, but BrowserHive is not behind it right now.
    return {
      outcome: 'unreachable',
      detail: `It answers HTTP ${status}: something in front of BrowserHive (a proxy or tunnel) cannot reach it.`,
      statusCode: status,
      browserhive: false,
    };
  }
  if ((result.contentType ?? '').includes('text/html')) {
    return {
      outcome: 'login',
      detail:
        'A web page answered instead of BrowserHive: probably a login or an access proxy in front.',
      statusCode: status,
      browserhive: false,
    };
  }
  return {
    outcome: 'elsewhere',
    detail: `Something answered with HTTP ${status}, but it is not BrowserHive.`,
    statusCode: status,
    browserhive: false,
  };
}

/** Dependencies of {@link PublicUrlChecker}. */
export interface PublicUrlCheckerDeps {
  readonly publicUrl: string | undefined;
  /** Where links point without `publicUrl` (the local listener). */
  readonly localUrl: () => string;
  readonly instanceId: string;
  readonly probe: UrlProbe;
  readonly clock: Clock;
  readonly cacheMs?: number;
}

/** Runs and caches the `publicUrl` check for `GET /system/public-url` and the System page. */
export class PublicUrlChecker {
  private cached: { readonly at: number; readonly verdict: PublicUrlVerdict } | undefined;
  private running: Promise<PublicUrlVerdict> | undefined;

  constructor(private readonly deps: PublicUrlCheckerDeps) {}

  /**
   * The current status; runs the probe when `refresh` is set or the cached result is older than a
   * minute. Never throws.
   *
   * @returns The status DTO.
   */
  async status(refresh = false): Promise<PublicUrlStatus> {
    const url = this.deps.publicUrl;
    const base = {
      configured: url !== undefined,
      url: url ?? null,
      local_url: this.deps.localUrl(),
      host_trusted: url !== undefined,
      insecure: isInsecurePublicUrl(url),
    };
    if (url === undefined) {
      return {
        ...base,
        outcome: 'unset',
        detail:
          'Not set: links in notifications open on this computer only. Set publicUrl to open them on your phone.',
        status_code: null,
        checked_at: null,
      };
    }
    const now = this.deps.clock.now();
    const fresh =
      !refresh &&
      this.cached !== undefined &&
      now - this.cached.at < (this.deps.cacheMs ?? PUBLIC_URL_CACHE_MS);
    if (!fresh) {
      this.running ??= this.check(url).finally(() => {
        this.running = undefined;
      });
      const verdict = await this.running;
      this.cached = { at: this.deps.clock.now(), verdict };
    }
    const cached = this.cached;
    if (cached === undefined) throw new Error('public url check produced no result');
    return {
      ...base,
      outcome: cached.verdict.outcome,
      detail: cached.verdict.detail,
      status_code: cached.verdict.statusCode,
      checked_at: cached.at,
    };
  }

  private async check(url: string): Promise<PublicUrlVerdict> {
    try {
      const result = await this.deps.probe(`${url}/health`, PUBLIC_URL_PROBE_TIMEOUT_MS);
      return classifyPublicUrlProbe(result, this.deps.instanceId);
    } catch (err) {
      return classifyPublicUrlProbe(
        { kind: 'error', detail: serializeError(err).message },
        this.deps.instanceId,
      );
    }
  }
}
