/** @module ports/logger — structured logger capability (spec 10 §4). */

/** Log severities, most to least severe. `trace` is ring-buffer only by default. */
export type LogLevel = 'error' | 'warn' | 'info' | 'debug' | 'trace';

/** Free-form structured fields attached to a record. Values are pre-redacted by the logger. */
export type LogFields = Readonly<Record<string, unknown>>;

/**
 * A bound structured logger. Messages are lowercase verb phrases without interpolated values;
 * all values go in `fields`. Implementations never throw from a log call.
 */
export interface Logger {
  /** Returns a logger with `bindings` merged into every record (e.g. `{ module, sessionId }`). */
  child(bindings: LogFields): Logger;
  /** True when a record at `level` would be emitted by at least one sink. */
  isLevelEnabled(level: LogLevel): boolean;
  error(msg: string, fields?: LogFields): void;
  warn(msg: string, fields?: LogFields): void;
  info(msg: string, fields?: LogFields): void;
  debug(msg: string, fields?: LogFields): void;
  trace(msg: string, fields?: LogFields): void;
}
