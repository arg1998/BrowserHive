/** @module test/helpers/collecting-logger — a Logger port double that records every call (domain/app tests must not import infra). */

import type { LogFields, Logger, LogLevel } from '../../src/ports/logger.ts';

/** One captured log call, with the child bindings merged into `fields`. */
export interface CapturedLog {
  readonly level: LogLevel;
  readonly msg: string;
  readonly fields: LogFields;
}

/** Records calls in memory; `child()` merges bindings into every record. */
export class CollectingLogger implements Logger {
  readonly records: CapturedLog[];

  constructor(
    private readonly bindings: LogFields = {},
    records: CapturedLog[] = [],
  ) {
    this.records = records;
  }

  child(bindings: LogFields): Logger {
    return new CollectingLogger({ ...this.bindings, ...bindings }, this.records);
  }

  isLevelEnabled(): boolean {
    return true;
  }

  error(msg: string, fields?: LogFields): void {
    this.push('error', msg, fields);
  }

  warn(msg: string, fields?: LogFields): void {
    this.push('warn', msg, fields);
  }

  info(msg: string, fields?: LogFields): void {
    this.push('info', msg, fields);
  }

  debug(msg: string, fields?: LogFields): void {
    this.push('debug', msg, fields);
  }

  trace(msg: string, fields?: LogFields): void {
    this.push('trace', msg, fields);
  }

  /** Records at `level`. */
  at(level: LogLevel): readonly CapturedLog[] {
    return this.records.filter((r) => r.level === level);
  }

  /** True when a record with `msg` was logged. */
  has(msg: string): boolean {
    return this.records.some((r) => r.msg === msg);
  }

  /** First record with `msg`, if any. */
  find(msg: string): CapturedLog | undefined {
    return this.records.find((r) => r.msg === msg);
  }

  private push(level: LogLevel, msg: string, fields: LogFields | undefined): void {
    this.records.push({ level, msg, fields: { ...this.bindings, ...fields } });
  }
}
