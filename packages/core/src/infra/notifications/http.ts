/** @module infra/notifications/http — the one HTTP helper of the platform adapters (spec 03 §9.5): timeouts, JSON/multipart/binary bodies, manual redirects for operator-supplied URLs, and the classification of every failure into a `ChannelSendError` that never carries a secret. */

import { ChannelSendError } from '../../ports/notification-channel.ts';

/** The `fetch` the adapters call; injectable for fakes. */
export type FetchFn = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

/** Default timeout of one platform call. */
export const PLATFORM_TIMEOUT_MS = 10_000;
/** Longest error detail kept (the outbox clips again). */
const DETAIL_MAX = 300;
/** Redirects followed on a same-origin hop before giving up. */
const MAX_REDIRECTS = 3;

/** One platform call. */
export interface PlatformCall {
  readonly url: string;
  readonly method: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: string | FormData | Blob | null;
  readonly timeoutMs?: number;
  /**
   * `follow` for the known platforms; `same-origin` follows a redirect only when it keeps the
   * scheme and host (the generic webhook, spec 03 §9.5), anything else is `rejected: redirect`.
   */
  readonly redirects?: 'follow' | 'same-origin';
  /** Whether a 404 means the addressed message is gone (edits and deletes). */
  readonly addressesMessage?: boolean;
  /** Cancels the call (the Telegram connect wait). */
  readonly signal?: AbortSignal;
}

/** A successful answer. */
export interface PlatformAnswer {
  readonly status: number;
  readonly headers: Headers;
  readonly text: string;
  /** The parsed JSON body, or `null` when the body is not JSON. */
  readonly json: unknown;
}

/** Everything the classifier knows about a failed answer. */
export interface FailedAnswer extends PlatformAnswer {
  /** The platform's own error sentence (`description`, `message`, `error`), scrubbed. */
  readonly detail: string;
}

/**
 * Platform-specific refinement of a failed answer (Telegram's 400 descriptions): return an error
 * to throw instead of the generic classification, or `null` for the default, or `'ok'` when the
 * failure is harmless ("message is not modified").
 */
export type FailureRefiner = (answer: FailedAnswer) => ChannelSendError | 'ok' | null;

/** Options of {@link callPlatform}. */
export interface CallOptions {
  readonly fetch: FetchFn;
  /** Literal secrets that must never appear in an error detail (tokens, webhook URLs). */
  readonly secrets: readonly string[];
  /** Platform name for messages (`Telegram`). */
  readonly platform: string;
  readonly refine?: FailureRefiner;
}

/**
 * Replaces every secret literal in `text` (and any bot-token-shaped path segment) with
 * `[redacted]`, then clips it.
 *
 * @returns The safe text.
 */
export function scrubDetail(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const secret of secrets) {
    if (secret.length >= 4) out = out.split(secret).join('[redacted]');
  }
  out = out.replace(/\/bot\d+:[A-Za-z0-9_-]+/g, '/bot[redacted]');
  out = out.replace(/\/api\/webhooks\/\d+\/[A-Za-z0-9_.-]+/g, '/api/webhooks/[redacted]');
  return out.length > DETAIL_MAX ? `${out.slice(0, DETAIL_MAX - 1)}…` : out;
}

function parseJson(text: string): unknown {
  if (text === '') return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function field(json: unknown, key: string): unknown {
  return json !== null && typeof json === 'object' ? Reflect.get(json, key) : undefined;
}

/**
 * The wait a 429 (or 503) asks for, in ms: Telegram `parameters.retry_after` (seconds), Discord
 * `retry_after` (float seconds), or the `Retry-After` header (seconds or an HTTP date).
 *
 * @returns Milliseconds, or `null` when the platform said nothing.
 */
export function retryAfterMs(answer: PlatformAnswer, now: () => number = Date.now): number | null {
  const parameters = field(answer.json, 'parameters');
  const fromParameters = field(parameters, 'retry_after');
  if (typeof fromParameters === 'number' && Number.isFinite(fromParameters)) {
    return Math.max(0, Math.ceil(fromParameters * 1000));
  }
  const fromBody = field(answer.json, 'retry_after');
  if (typeof fromBody === 'number' && Number.isFinite(fromBody)) {
    return Math.max(0, Math.ceil(fromBody * 1000));
  }
  const header = answer.headers.get('retry-after');
  if (header !== null && header.trim() !== '') {
    const seconds = Number(header);
    if (Number.isFinite(seconds)) return Math.max(0, Math.ceil(seconds * 1000));
    const at = Date.parse(header);
    if (Number.isFinite(at)) return Math.max(0, at - now());
  }
  return null;
}

function detailOf(answer: PlatformAnswer, secrets: readonly string[]): string {
  const json = answer.json;
  for (const key of ['description', 'message', 'error']) {
    const value = field(json, key);
    if (typeof value === 'string' && value !== '') return scrubDetail(value, secrets);
  }
  const text = answer.text.replace(/\s+/g, ' ').trim();
  return scrubDetail(text === '' ? `HTTP ${answer.status}` : text, secrets);
}

/**
 * The default classification of a failed answer (N0 handoff §6.1, spec 03 §9.5).
 *
 * @returns The error to throw.
 */
export function classifyFailure(
  answer: FailedAnswer,
  platform: string,
  addressesMessage: boolean,
): ChannelSendError {
  const { status, detail } = answer;
  const message = `${platform} ${status}: ${detail}`;
  if (status === 429) {
    return new ChannelSendError('rate_limited', message, { retryAfterMs: retryAfterMs(answer) });
  }
  if (status === 401 || status === 403) return new ChannelSendError('auth', message);
  if (status === 404 && addressesMessage) return new ChannelSendError('message_gone', message);
  if (status === 408) return new ChannelSendError('timeout', message);
  if (status >= 500) {
    return new ChannelSendError('unavailable', message, { retryAfterMs: retryAfterMs(answer) });
  }
  return new ChannelSendError('rejected', message);
}

function combinedSignal(timeoutMs: number, external?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return external === undefined ? timeout : AbortSignal.any([timeout, external]);
}

function isAbort(err: unknown): boolean {
  return (
    err instanceof Error &&
    (err.name === 'AbortError' ||
      err.name === 'TimeoutError' ||
      /abort|timed? ?out/i.test(err.message))
  );
}

async function once(call: PlatformCall, url: string, options: CallOptions): Promise<Response> {
  try {
    return await options.fetch(url, {
      method: call.method,
      headers: { 'user-agent': 'BrowserHive', ...call.headers },
      ...(call.body !== undefined && call.body !== null && { body: call.body }),
      redirect: call.redirects === 'same-origin' ? 'manual' : 'follow',
      signal: combinedSignal(call.timeoutMs ?? PLATFORM_TIMEOUT_MS, call.signal),
    });
  } catch (err) {
    if (isAbort(err)) {
      throw new ChannelSendError('timeout', `${options.platform} did not answer in time`);
    }
    const raw = err instanceof Error ? err.message : String(err);
    throw new ChannelSendError(
      'unavailable',
      `${options.platform} unreachable: ${scrubDetail(raw.replace(/https?:\/\/\S+/g, '<url>'), options.secrets)}`,
    );
  }
}

/**
 * Makes one platform call and returns the answer, or throws a classified `ChannelSendError`
 * whose message never contains a secret.
 *
 * @returns The 2xx answer.
 */
export async function callPlatform(
  call: PlatformCall,
  options: CallOptions,
): Promise<PlatformAnswer> {
  let url = call.url;
  let response = await once(call, url, options);
  for (let hop = 0; call.redirects === 'same-origin' && hop < MAX_REDIRECTS; hop++) {
    if (response.status < 300 || response.status >= 400) break;
    const location = response.headers.get('location');
    if (location === null) break;
    const from = new URL(url);
    let next: URL;
    try {
      next = new URL(location, from);
    } catch {
      throw new ChannelSendError('rejected', `${options.platform} redirect: invalid location`);
    }
    if (next.protocol !== from.protocol || next.host !== from.host) {
      throw new ChannelSendError(
        'rejected',
        `${options.platform} redirect: refused a redirect to another scheme or host`,
      );
    }
    url = next.toString();
    response = await once(call, url, options);
  }
  const text = await response.text().catch(() => '');
  const answer: PlatformAnswer = {
    status: response.status,
    headers: response.headers,
    text,
    json: parseJson(text),
  };
  if (response.status >= 200 && response.status < 300) return answer;
  if (response.status >= 300 && response.status < 400) {
    throw new ChannelSendError('rejected', `${options.platform} redirect: not followed`);
  }
  const failed: FailedAnswer = { ...answer, detail: detailOf(answer, options.secrets) };
  const refined = options.refine?.(failed) ?? null;
  if (refined === 'ok') return answer;
  if (refined !== null) throw refined;
  throw classifyFailure(failed, options.platform, call.addressesMessage === true);
}

/**
 * Builds a multipart body: every string field as is, every other value as JSON, and the file
 * under `fileField`.
 *
 * @returns The form data.
 */
export function multipart(
  fields: Readonly<Record<string, unknown>>,
  file: {
    readonly field: string;
    readonly bytes: Uint8Array;
    readonly name: string;
    readonly type: string;
  } | null,
): FormData {
  const form = new FormData();
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined || value === null) continue;
    form.append(key, typeof value === 'string' ? value : JSON.stringify(value));
  }
  if (file !== null) {
    form.append(file.field, new Blob([new Uint8Array(file.bytes)], { type: file.type }), file.name);
  }
  return form;
}

/**
 * Replaces `{secret:<param>}` placeholders in a string with the resolved values.
 *
 * @returns The substituted text.
 */
export function substituteSecrets(text: string, secrets: Readonly<Record<string, string>>): string {
  return text.replace(/\{secret:([a-z_]+)\}/g, (whole, param: string) => secrets[param] ?? whole);
}
