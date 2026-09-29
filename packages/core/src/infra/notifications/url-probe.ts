/** @module infra/notifications/url-probe — one GET without following redirects, for the `publicUrl` check (spec 08 §5.8). */

import { serializeError } from '../../kernel/errors/serialize-error.ts';
import type { UrlProbe, UrlProbeResult } from '../../ports/notification-channel.ts';
import type { FetchFn } from './http.ts';

/** Most body bytes kept. */
const BODY_MAX = 64 * 1024;

/** Options of {@link createUrlProbe}. */
export interface UrlProbeOptions {
  readonly fetch?: FetchFn;
}

async function readCapped(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  if (reader === undefined) return '';
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (size < BODY_MAX) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    size += value.length;
  }
  await reader.cancel().catch(() => undefined);
  const all = new Uint8Array(Math.min(size, BODY_MAX));
  let at = 0;
  for (const chunk of chunks) {
    const part = chunk.subarray(0, Math.max(0, all.length - at));
    all.set(part, at);
    at += part.length;
  }
  return new TextDecoder().decode(all);
}

/**
 * The URL probe: GET with `redirect: 'manual'`, a timeout, and at most 64 KiB of body.
 *
 * @returns The probe.
 */
export function createUrlProbe(options: UrlProbeOptions = {}): UrlProbe {
  const fetchFn = options.fetch ?? fetch;
  return async (url: string, timeoutMs: number): Promise<UrlProbeResult> => {
    try {
      const response = await fetchFn(url, {
        method: 'GET',
        redirect: 'manual',
        headers: { accept: 'application/json', 'user-agent': 'BrowserHive publicUrl check' },
        signal: AbortSignal.timeout(timeoutMs),
      });
      return {
        kind: 'response',
        status: response.status,
        contentType: response.headers.get('content-type'),
        location: response.headers.get('location'),
        body: await readCapped(response),
      };
    } catch (err) {
      const name = err instanceof Error ? err.name : '';
      const detail =
        name === 'TimeoutError' || name === 'AbortError'
          ? `no answer within ${Math.round(timeoutMs / 1000)} s`
          : serializeError(err).message.replace(/https?:\/\/\S+/g, '<url>');
      return { kind: 'error', detail };
    }
  };
}
