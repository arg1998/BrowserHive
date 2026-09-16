/** @module infra/persistence/dialect/spans — `db.*` span helpers over the `browserhive` tracer (spec 10 §6). */

import { type Attributes, type Span, SpanStatusCode, trace } from '@opentelemetry/api';

/** The one tracer every persistence span is created from. */
export const tracer = trace.getTracer('browserhive');

/** Attributes every `db.*` span carries. */
export const DB_ATTRIBUTES: Attributes = { 'db.system': 'sqlite' };

/**
 * Runs `fn` inside a span named `name`; records the error and sets ERROR status when it throws.
 * Works for synchronous and asynchronous bodies (the span ends when the promise settles).
 */
export function withSpan<T>(name: string, attributes: Attributes, fn: (span: Span) => T): T {
  return tracer.startActiveSpan(
    name,
    { attributes: { ...DB_ATTRIBUTES, ...attributes } },
    (span) => {
      let result: T;
      try {
        result = fn(span);
      } catch (error) {
        fail(span, error);
        span.end();
        throw error;
      }
      if (result instanceof Promise) {
        // `T` is a promise type here; the same promise is returned after settling the span.
        return result.then(
          (value: unknown) => {
            span.end();
            return value;
          },
          (error: unknown) => {
            fail(span, error);
            span.end();
            throw error;
          },
        ) as T;
      }
      span.end();
      return result;
    },
  );
}

function fail(span: Span, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  span.recordException(error instanceof Error ? error : new Error(message));
  span.setStatus({ code: SpanStatusCode.ERROR, message });
}

/** First SQL keyword, lowercased — the `db.operation` attribute value. */
export function sqlOperation(sql: string): string {
  const match = /^\s*(?:--[^\n]*\n\s*)*([a-zA-Z]+)/.exec(sql);
  return (match?.[1] ?? 'unknown').toLowerCase();
}
