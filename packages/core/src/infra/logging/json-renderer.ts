/** @module infra/logging/json-renderer — one JSON object per line with a fixed leading key order, whole line scrubbed (spec 10 §4.2). */

import type { LogRecord } from './record.ts';

/** Leading keys, in this order; every other field follows in insertion order. */
export const JSON_KEY_ORDER: readonly string[] = [
  'ts',
  'level',
  'msg',
  'module',
  'trace_id',
  'span_id',
  'request_id',
  'session_id',
  'principal',
  'transport',
  'err',
];

/**
 * Renders `record` as a single JSON line (no trailing newline). `scrub` runs over the finished
 * line so a literal that only forms after serialization (escaped quotes, joined values) is
 * still caught.
 */
export function renderJson(record: LogRecord, scrub: (line: string) => string = (l) => l): string {
  const ordered: Record<string, unknown> = {};
  for (const key of JSON_KEY_ORDER) {
    const value = record[key];
    if (value !== undefined) ordered[key] = value;
  }
  for (const [key, value] of Object.entries(record)) {
    if (!JSON_KEY_ORDER.includes(key) && value !== undefined) ordered[key] = value;
  }
  let line: string;
  try {
    line = JSON.stringify(ordered, replacer);
  } catch {
    line = JSON.stringify({
      ts: record.ts,
      level: record.level,
      msg: record.msg,
      module: record.module,
      unserializable: true,
    });
  }
  return scrub(line);
}

function replacer(_key: string, value: unknown): unknown {
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Error) return { name: value.name, message: value.message };
  return value;
}
