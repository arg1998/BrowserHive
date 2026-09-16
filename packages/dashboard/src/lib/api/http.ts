/** @module lib/api/http — fetch transport with timeouts, problem+json mapping and the 401/403 auth interceptors (spec 04 §4.1, §5) */
import { API_PREFIX } from '@browserhive/contracts/http';
import { abortedError, appErrorFromResponse, networkError, timeoutError } from './errors.ts';

/** Signals the transport raises so the auth machine can react (spec 04 §4.1). */
export interface AuthSignals {
  /** A lost session (401 `UNAUTHORIZED` outside `login`) → the machine goes to `login` and the query cache is cleared. */
  readonly onUnauthorized: (operationId: string) => void;
  /** Any 403 `PASSWORD_CHANGE_REQUIRED` → the machine goes to `change`. */
  readonly onPasswordChangeRequired: (operationId: string) => void;
}

/** One transport request. `path` is relative to the API prefix and already carries its query string. */
export interface HttpRequest {
  readonly operationId: string;
  readonly method: string;
  readonly path: string;
  readonly body?: unknown;
  readonly headers?: Readonly<Record<string, string>>;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
}

/** Transport result for a 2xx answer. */
export interface HttpResult {
  readonly status: number;
  /** Parsed JSON body; `undefined` for 204 / empty bodies. */
  readonly body: unknown;
  readonly headers: Headers;
}

/** The part of `fetch` the transport needs (Bun's `typeof fetch` carries extra statics). */
export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

/** Transport options. */
export interface HttpOptions {
  readonly fetch?: FetchLike;
  /** Defaults to `/api/v1`. */
  readonly baseUrl?: string;
  readonly signals?: Partial<AuthSignals>;
  /** Default per-request timeout. */
  readonly timeoutMs?: number;
}

/** Default request timeout (the auth probe uses 8 s, spec 04 §4.1). */
export const DEFAULT_TIMEOUT_MS = 30_000;

/** Operations whose 401 is an expected answer, not a lost session. */
const UNAUTHORIZED_IS_NORMAL: ReadonlySet<string> = new Set(['login']);

/**
 * Only this code means the operator's own session is gone. Other 401s are domain answers about a
 * different credential (e.g. `VAULT_UNLOCK_FAILED` for a rejected Bitwarden token) and must not
 * sign the operator out.
 */
const SESSION_LOST_CODE = 'UNAUTHORIZED';

/** Combine the caller's signal with a timeout; returns the signal and whether the timeout fired. */
function withTimeout(
  signal: AbortSignal | undefined,
  timeoutMs: number,
): { readonly signal: AbortSignal; readonly timedOut: () => boolean; readonly clear: () => void } {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  const forward = () => controller.abort();
  if (signal !== undefined) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener('abort', forward, { once: true });
  }
  return {
    signal: controller.signal,
    timedOut: () => timedOut,
    clear: () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', forward);
    },
  };
}

/** Parse a body as JSON when the response says it is; `undefined` for empty bodies. */
async function readBody(response: Response): Promise<unknown> {
  if (response.status === 204 || response.status === 205) return undefined;
  const type = response.headers.get('content-type') ?? '';
  const text = await response.text();
  if (text.length === 0) return undefined;
  if (/json/i.test(type)) {
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }
  return text;
}

/** The transport. Every request goes through here (cookies, JSON, timeouts, interceptors). */
export interface HttpTransport {
  request(request: HttpRequest): Promise<HttpResult>;
}

/** Build the transport. */
export function createHttp(options: HttpOptions = {}): HttpTransport {
  const doFetch: FetchLike = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
  const baseUrl = options.baseUrl ?? API_PREFIX;
  const defaultTimeout = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return {
    async request(request) {
      const timeout = withTimeout(request.signal, request.timeoutMs ?? defaultTimeout);
      const headers: Record<string, string> = { Accept: 'application/json', ...request.headers };
      const hasBody = request.body !== undefined;
      if (hasBody) headers['Content-Type'] = 'application/json';
      let response: Response;
      try {
        response = await doFetch(`${baseUrl}${request.path}`, {
          method: request.method.toUpperCase(),
          headers,
          credentials: 'same-origin',
          signal: timeout.signal,
          ...(hasBody && { body: JSON.stringify(request.body) }),
        });
      } catch (error) {
        timeout.clear();
        if (timeout.timedOut()) throw timeoutError(request.timeoutMs ?? defaultTimeout);
        if (request.signal?.aborted === true) throw abortedError();
        throw networkError(error);
      }
      let body: unknown;
      try {
        body = await readBody(response);
      } catch (error) {
        timeout.clear();
        if (timeout.timedOut()) throw timeoutError(request.timeoutMs ?? defaultTimeout);
        throw networkError(error);
      } finally {
        timeout.clear();
      }
      if (response.ok) return { status: response.status, body, headers: response.headers };
      const error = appErrorFromResponse(response.status, body, response.headers);
      if (
        error.status === 401 &&
        error.code === SESSION_LOST_CODE &&
        !UNAUTHORIZED_IS_NORMAL.has(request.operationId)
      ) {
        options.signals?.onUnauthorized?.(request.operationId);
      } else if (error.status === 403 && error.code === 'PASSWORD_CHANGE_REQUIRED') {
        options.signals?.onPasswordChangeRequired?.(request.operationId);
      }
      throw error;
    },
  };
}
