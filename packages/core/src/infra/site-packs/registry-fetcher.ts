/** @module infra/site-packs/registry-fetcher — the registry client's one kind of request (spec 13 §10.4, D-55): an anonymous `GET` of a file under `sitePacksUrl` with `User-Agent: BrowserHive`, no cookie, query, body or redirect, keep-alive off, 5 s to the response headers and 30 s in all, the body capped while it streams. `If-None-Match` carries only the SHA-256 of the body BrowserHive holds (D69). */

import type {
  RegistryFetcher,
  RegistryFetchRequest,
  RegistryFetchResult,
} from '../../ports/site-pack-registry.ts';

/** The only `User-Agent` the client sends: no version, no install identifier. */
export const REGISTRY_USER_AGENT = 'BrowserHive';
/** Time to the response headers (the connect timeout of §10.4, with the server's first byte). */
export const HEADERS_TIMEOUT_MS = 5_000;
/** Time for the whole request. */
export const TOTAL_TIMEOUT_MS = 30_000;

/** A registry path: `keys.json`-style names or `packs/<id>/<sha256>.json`, never a query or `..`. */
const PATH_RE = /^(?:[a-z.]+\.json(?:\.sig)?|packs\/[a-z0-9.-]+\/[0-9a-f]{64}\.json)$/;

/** Options of {@link createRegistryFetcher}. */
export interface RegistryFetcherOptions {
  /** `sitePacksUrl` (normalised to end in `/`). */
  readonly url: string;
  /**
   * Accept `http:` for a loopback host (127.0.0.1, ::1, localhost): only the testing seam of
   * `createServer` sets it, for a local fake registry (spec 13 §10.2).
   */
  readonly allowLoopbackHttp?: boolean;
  /** The fetch implementation (tests). */
  readonly fetch?: typeof fetch;
  readonly headersTimeoutMs?: number;
  readonly totalTimeoutMs?: number;
}

/** Why `url` may not be used, or `null`. */
export function registryUrlProblem(url: string, allowLoopbackHttp = false): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return `'${url}' is not a URL`;
  }
  if (parsed.username !== '' || parsed.password !== '') return 'the URL carries credentials';
  if (parsed.search !== '' || parsed.hash !== '') return 'the URL carries a query or fragment';
  if (parsed.protocol === 'https:') return null;
  const loopback = ['127.0.0.1', '[::1]', 'localhost'].includes(parsed.hostname);
  if (parsed.protocol === 'http:' && allowLoopbackHttp && loopback) return null;
  return 'the registry is reached over https only';
}

function dateOf(headers: Headers): number | null {
  const value = headers.get('date');
  if (value === null) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

/** Reads at most `max` bytes of the body; `null` past it (the stream is cancelled). */
async function readCapped(response: Response, max: number): Promise<Uint8Array | null> {
  const body = response.body;
  if (body === null) return new Uint8Array(0);
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

/** The registry fetcher over `fetch`. */
export function createRegistryFetcher(options: RegistryFetcherOptions): RegistryFetcher {
  const doFetch = options.fetch ?? fetch;
  const headersTimeout = options.headersTimeoutMs ?? HEADERS_TIMEOUT_MS;
  const totalTimeout = options.totalTimeoutMs ?? TOTAL_TIMEOUT_MS;
  const urlProblem = registryUrlProblem(options.url, options.allowLoopbackHttp === true);
  return {
    url: options.url,
    async fetch(request: RegistryFetchRequest, signal?: AbortSignal): Promise<RegistryFetchResult> {
      const failed = (
        reason: Extract<RegistryFetchResult, { kind: 'failed' }>['reason'],
        detail: string,
        status: number | null = null,
        date: number | null = null,
      ): RegistryFetchResult => ({ kind: 'failed', reason, status, detail, date });
      if (urlProblem !== null) return failed('insecure_url', urlProblem);
      if (!PATH_RE.test(request.path))
        return failed('insecure_url', `refused path ${request.path}`);
      const target = new URL(request.path, options.url);
      const headers: Record<string, string> = {
        'User-Agent': REGISTRY_USER_AGENT,
        Accept: 'application/json',
      };
      if (request.heldSha256 !== undefined) headers['If-None-Match'] = `"${request.heldSha256}"`;
      const controller = new AbortController();
      const abort = () => controller.abort();
      signal?.addEventListener('abort', abort, { once: true });
      const total = setTimeout(abort, totalTimeout);
      const firstByte = setTimeout(abort, headersTimeout);
      try {
        const response = await doFetch(target, {
          method: 'GET',
          headers,
          redirect: 'manual',
          credentials: 'omit',
          cache: 'no-store',
          keepalive: false,
          signal: controller.signal,
        });
        clearTimeout(firstByte);
        const date = dateOf(response.headers);
        if (response.status === 304) {
          await response.body?.cancel().catch(() => undefined);
          return request.heldSha256 === undefined
            ? failed(
                'not_modified_without_body',
                '304 for a file BrowserHive does not hold',
                304,
                date,
              )
            : { kind: 'not_modified', date };
        }
        if (response.status >= 300 && response.status < 400) {
          await response.body?.cancel().catch(() => undefined);
          return failed(
            'redirect',
            `HTTP ${response.status}: redirects are not followed`,
            response.status,
            date,
          );
        }
        if (response.status !== 200) {
          await response.body?.cancel().catch(() => undefined);
          return failed('http_status', `HTTP ${response.status}`, response.status, date);
        }
        const bytes = await readCapped(response, request.maxBytes);
        if (bytes === null) {
          return failed('too_large', `larger than ${request.maxBytes} bytes`, 200, date);
        }
        return { kind: 'ok', bytes, date };
      } catch (error) {
        if (controller.signal.aborted && signal?.aborted !== true) {
          return failed(
            'timeout',
            `no answer within ${headersTimeout / 1000} s or ${totalTimeout / 1000} s in all`,
          );
        }
        return failed('network', error instanceof Error ? error.message : String(error));
      } finally {
        clearTimeout(firstByte);
        clearTimeout(total);
        signal?.removeEventListener('abort', abort);
      }
    },
  };
}
