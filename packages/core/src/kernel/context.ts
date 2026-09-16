/** @module kernel/context — AsyncLocalStorage-backed request context for log/trace correlation (spec 10 §5, D-08). */

import { AsyncLocalStorage } from 'node:async_hooks';

/** The entry point that established a request context. */
export type RequestTransport = 'http' | 'stdio' | 'ws' | 'cli';

/**
 * Correlation record established once per inbound unit of work (HTTP request, MCP tool call,
 * WS command, CLI command). The logger stamps its fields on every record automatically.
 *
 * @remarks Keys are camelCase in TypeScript (D-23); the logger renders them as
 * `trace_id`, `span_id`, `request_id`, `session_id`, `principal` on the wire.
 */
export interface RequestContext {
  /** 32 lowercase hex chars; adopted from `traceparent` when present, else minted. */
  readonly traceId: string;
  /** 16 lowercase hex chars of the current span. */
  readonly spanId: string;
  /** Request id echoed to clients (`request_id` in problem+json, MCP `ref`). */
  readonly requestId?: string;
  /** Session the work targets, once known. */
  readonly sessionId?: string;
  /** Tool-call event id (doubles as the tool span's correlation key). */
  readonly eventId?: string;
  /** Authenticated principal id, once known. */
  readonly principal?: string;
  /** Which entry point established the context. */
  readonly transport: RequestTransport;
}

const storage = new AsyncLocalStorage<RequestContext>();

/**
 * Runs `fn` with `context` as the current request context for every async continuation it starts.
 *
 * @returns Whatever `fn` returns (sync or a promise).
 */
export function runWithRequestContext<T>(context: RequestContext, fn: () => T): T {
  return storage.run(context, fn);
}

/** The request context of the current async continuation, or `undefined` outside any entry point. */
export function currentRequestContext(): RequestContext | undefined {
  return storage.getStore();
}

/** Partial update for {@link extendRequestContext}; `undefined` entries are ignored. */
export type RequestContextPatch = {
  readonly [K in keyof RequestContext]?: RequestContext[K] | undefined;
};

/**
 * Runs `fn` with the current context extended by `patch` (e.g. once `sessionId` is known).
 * Without a current context the patch alone is not enough to form one, so `fn` runs unchanged.
 */
export function extendRequestContext<T>(patch: RequestContextPatch, fn: () => T): T {
  const current = storage.getStore();
  if (current === undefined) return fn();
  const next: RequestContext = {
    ...current,
    ...(patch.traceId !== undefined && { traceId: patch.traceId }),
    ...(patch.spanId !== undefined && { spanId: patch.spanId }),
    ...(patch.requestId !== undefined && { requestId: patch.requestId }),
    ...(patch.sessionId !== undefined && { sessionId: patch.sessionId }),
    ...(patch.eventId !== undefined && { eventId: patch.eventId }),
    ...(patch.principal !== undefined && { principal: patch.principal }),
    ...(patch.transport !== undefined && { transport: patch.transport }),
  };
  return storage.run(next, fn);
}

/**
 * Captures the current request context and returns a wrapper that restores it whenever the wrapped
 * function runs later (timers, event listeners, queue drains). With no current context the
 * function is returned unchanged.
 */
export function bindRequestContext<A extends readonly unknown[], R>(
  fn: (...args: A) => R,
): (...args: A) => R {
  const captured = storage.getStore();
  if (captured === undefined) return fn;
  return (...args: A): R => storage.run(captured, () => fn(...args));
}
