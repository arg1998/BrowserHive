/** @module infra/logging/collecting-logger — in-memory Logger for tests: records every call with its bindings (spec 05 §7). */

import type { LogFields, Logger, LogLevel } from '../../ports/logger.ts';
import { LEVEL_ORDER } from './level-spec.ts';

/** One captured log call. */
export interface CollectedRecord {
  readonly level: LogLevel;
  readonly msg: string;
  /** Call fields only. */
  readonly fields: LogFields;
  /** Bindings of the logger (or child) that made the call. */
  readonly bindings: LogFields;
  /** Bindings merged with fields (fields win). */
  readonly all: LogFields;
}

/** A logger that stores records instead of rendering them. */
export interface CollectingLogger extends Logger {
  /** Every record captured so far, in call order (shared across children). */
  readonly records: readonly CollectedRecord[];
  /** Records at `level`, or all when omitted. */
  at(level?: LogLevel): readonly CollectedRecord[];
  /** Records whose message equals `msg`. */
  find(msg: string): readonly CollectedRecord[];
  /** True when at least one record has message `msg`. */
  has(msg: string): boolean;
  /** Messages in call order. */
  messages(): readonly string[];
  /** Drops every record. */
  clear(): void;
}

/** Options for {@link createCollectingLogger}. */
export interface CollectingLoggerOptions {
  /** Threshold; default `trace` so tests see everything. */
  readonly level?: LogLevel;
  /** Root bindings. */
  readonly bindings?: LogFields;
}

/** Builds a {@link CollectingLogger}. Children share the parent's record list. */
export function createCollectingLogger(options: CollectingLoggerOptions = {}): CollectingLogger {
  const records: CollectedRecord[] = [];
  const threshold = options.level ?? 'trace';
  const make = (bindings: LogFields): CollectingLogger => {
    const emit = (level: LogLevel, msg: string, fields: LogFields = {}): void => {
      if (LEVEL_ORDER[level] > LEVEL_ORDER[threshold]) return;
      records.push({ level, msg, fields, bindings, all: { ...bindings, ...fields } });
    };
    return {
      records,
      child: (extra) => make({ ...bindings, ...extra }),
      isLevelEnabled: (level) => LEVEL_ORDER[level] <= LEVEL_ORDER[threshold],
      error: (msg, fields) => emit('error', msg, fields),
      warn: (msg, fields) => emit('warn', msg, fields),
      info: (msg, fields) => emit('info', msg, fields),
      debug: (msg, fields) => emit('debug', msg, fields),
      trace: (msg, fields) => emit('trace', msg, fields),
      at: (level) =>
        level === undefined ? [...records] : records.filter((r) => r.level === level),
      find: (msg) => records.filter((r) => r.msg === msg),
      has: (msg) => records.some((r) => r.msg === msg),
      messages: () => records.map((r) => r.msg),
      clear: () => {
        records.length = 0;
      },
    };
  };
  return make(options.bindings ?? {});
}
