/** @module app/observability/tool-result-policy — D-20 recording of tool results: `full|shape|none`, 16 KiB cap, redaction. */

import type { RecordToolResults } from '@browserhive/contracts/enums';
import type { Redactor } from '../../kernel/redact.ts';

/** Hard cap on persisted result text (16 KiB): enough for diagnosis, bounded row size. */
export const RESULT_TEXT_CAP_BYTES = 16 * 1024;

/** Marker appended when a result was cut at the cap. */
export const TRUNCATION_MARKER = '…[truncated]';

const encoder = new TextEncoder();

/** Cuts `text` to at most `maxBytes` of UTF-8 without splitting a code point; marks the cut. */
export function capUtf8(text: string, maxBytes: number): string {
  if (encoder.encode(text).length <= maxBytes) return text;
  const budget = Math.max(0, maxBytes - encoder.encode(TRUNCATION_MARKER).length);
  let low = 0;
  let high = text.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (encoder.encode(text.slice(0, mid)).length <= budget) low = mid;
    else high = mid - 1;
  }
  return `${text.slice(0, low)}${TRUNCATION_MARKER}`;
}

/** A `shape` description: type and, for objects/arrays, the top-level keys or length. */
export function describeShape(text: string): string {
  const bytes = encoder.encode(text).length;
  let shape: Record<string, unknown>;
  try {
    const value: unknown = JSON.parse(text);
    if (Array.isArray(value)) shape = { type: 'array', length: value.length };
    else if (value !== null && typeof value === 'object')
      shape = { type: 'object', keys: Object.keys(value).sort() };
    else shape = { type: value === null ? 'null' : typeof value };
  } catch {
    shape = { type: 'text' };
  }
  return JSON.stringify({ shape, bytes });
}

/**
 * Applies the `recordToolResults` policy: `full` keeps the redacted text capped at
 * {@link RESULT_TEXT_CAP_BYTES}, `shape` keeps key names and sizes only, `none` keeps nothing.
 */
export function applyResultPolicy(
  text: string | null,
  mode: RecordToolResults,
  redactor: Redactor,
): string | null {
  if (text === null) return null;
  switch (mode) {
    case 'full':
      return capUtf8(redactor.scrubText(text), RESULT_TEXT_CAP_BYTES);
    case 'shape':
      return describeShape(text);
    case 'none':
      return null;
    default:
      return null;
  }
}
