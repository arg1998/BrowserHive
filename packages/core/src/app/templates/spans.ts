/** @module app/templates/spans — the template spans of spec 13 §11.7 written by T1b (`template.checkpoint`, `template.restore`), on the global tracer like the other app-layer spans. */

import { SpanStatusCode, trace } from '@opentelemetry/api';

/** Runs `fn` inside a span named `name`; an error marks the span and is rethrown. */
export async function inTemplateSpan<T>(
  name: 'template.checkpoint' | 'template.restore',
  attributes: Readonly<Record<string, string | number>>,
  fn: () => Promise<T>,
  outcome?: (value: T) => Readonly<Record<string, string | number>>,
): Promise<T> {
  return await trace
    .getTracer('browserhive')
    .startActiveSpan(name, { attributes: { ...attributes } }, async (span) => {
      try {
        const value = await fn();
        if (outcome !== undefined) span.setAttributes({ ...outcome(value) });
        return value;
      } catch (err) {
        span.setStatus({ code: SpanStatusCode.ERROR });
        throw err;
      } finally {
        span.end();
      }
    });
}
