/** @module infra/logging/logger.test — createLogger: levels, children, context stamping, serializers, redaction, sinks. */

import { describe, expect, it } from 'bun:test';
import { currentRequestContext, runWithRequestContext } from '../../kernel/context.ts';
import { AppError } from '../../kernel/errors/app-error.ts';
import { createRedactor, REDACTED, SecretRegistry } from '../../kernel/redact.ts';
import { secret } from '../../kernel/secret.ts';
import { createFakeClock } from '../clock/system-clock.ts';
import { type CreateLoggerOptions, createLogger } from './logger.ts';
import { createRingBuffer } from './ring-buffer.ts';

function jsonLogger(overrides: Partial<CreateLoggerOptions> = {}) {
  const lines: string[] = [];
  const logger = createLogger({
    level: 'info',
    format: 'json',
    clock: createFakeClock(1_000),
    stream: { write: (c: string) => lines.push(c.trimEnd()) },
    context: () => undefined,
    traceIds: () => undefined,
    ...overrides,
  });
  const parsed = (): Record<string, unknown>[] => lines.map((l) => JSON.parse(l));
  return { logger, lines, parsed };
}

describe('createLogger', () => {
  it('emits ordered JSON with ts from the clock and snake_case fields', () => {
    const { logger, parsed } = jsonLogger();
    logger
      .child({ module: 'sessions.lifecycle' })
      .info('session opened', { sessionId: 's-1', durationMs: 5 });
    expect(parsed()).toEqual([
      {
        ts: 1_000,
        level: 'info',
        msg: 'session opened',
        module: 'sessions.lifecycle',
        session_id: 's-1',
        duration_ms: 5,
      },
    ]);
  });

  it('honours per-module levels and runtime setLevel', () => {
    const { logger, parsed } = jsonLogger({
      level: { default: 'info', modules: { sessions: 'debug' } },
    });
    const sessions = logger.child({ module: 'sessions' });
    const http = logger.child({ module: 'http.routes' });
    sessions.debug('a');
    http.debug('b');
    expect(sessions.isLevelEnabled('debug')).toBe(true);
    expect(http.isLevelEnabled('debug')).toBe(false);
    logger.setLevel('debug');
    http.debug('c');
    expect(parsed().map((r) => r['msg'])).toEqual(['a', 'c']);
    expect(logger.getLevel()).toEqual({ default: 'debug', modules: {} });
  });

  it('stamps trace/span/request/session/principal/transport from the context', () => {
    const { logger, parsed } = jsonLogger({ context: currentRequestContext });
    runWithRequestContext(
      {
        traceId: 'a'.repeat(32),
        spanId: 'b'.repeat(16),
        requestId: 'r-1',
        sessionId: 's-1',
        principal: 'p-1',
        transport: 'http',
      },
      () => logger.info('hit'),
    );
    expect(parsed()[0]).toEqual({
      ts: 1_000,
      level: 'info',
      msg: 'hit',
      module: 'app',
      trace_id: 'a'.repeat(32),
      span_id: 'b'.repeat(16),
      request_id: 'r-1',
      session_id: 's-1',
      principal: 'p-1',
      transport: 'http',
    });
  });

  it('prefers active span ids over the context and namespaces owned-key collisions', () => {
    const { logger, parsed } = jsonLogger({
      context: () => ({ traceId: 'ctx', spanId: 'ctx', requestId: 'r-1', transport: 'cli' }),
      traceIds: () => ({ traceId: 'span-trace', spanId: 'span-span' }),
    });
    logger.info('x', {
      ts: 9,
      level: 'silly',
      requestId: 'r-other',
      sessionId: 's-1',
      transport: 'cli',
    });
    expect(parsed()[0]).toEqual({
      ts: 1_000,
      level: 'info',
      msg: 'x',
      module: 'app',
      trace_id: 'span-trace',
      span_id: 'span-span',
      request_id: 'r-1',
      session_id: 's-1',
      transport: 'cli',
      fields: { ts: 9, level: 'silly', request_id: 'r-other' },
    });
  });

  it('serializes err with stack and code, sanitizes url, maps duration', () => {
    const { logger, parsed } = jsonLogger();
    const cause = new Error('inner');
    const err = new AppError('SESSION_NOT_FOUND', { session_id: 's' }, { cause });
    logger.error('tool call failed', { err, url: 'https://u:p@e.com/a?token=1#f', duration: 42 });
    const record = parsed()[0] ?? {};
    const serialized = record['err'] as Record<string, unknown>;
    expect(serialized['code']).toBe('SESSION_NOT_FOUND');
    expect(typeof serialized['stack']).toBe('string');
    expect((serialized['cause'] as Record<string, unknown>)['message']).toBe('inner');
    expect(record['url']).toBe('https://e.com/a');
    expect(record['duration_ms']).toBe(42);
    expect(record['duration']).toBeUndefined();
    expect(Object.keys(record).indexOf('err')).toBeLessThan(Object.keys(record).indexOf('url'));
  });

  it('always renders err as a serialized error and omits null correlation keys', () => {
    const { logger, parsed } = jsonLogger();
    logger.error('request failed', { err: { code: 42 }, principal: null, request_id: null });
    logger.error('tool failed', { err: { name: 'AppError', message: 'boom', code: 'X' } });
    logger.error('odd throw', { err: 'plain' });
    logger.warn('kept as field', { error: { reason: 'x' }, err: null });
    const [plainObject, serialized, text, field] = parsed();
    expect(plainObject?.['err']).toEqual({ name: 'NonError', message: '{"code":42}' });
    expect(plainObject).not.toHaveProperty('principal');
    expect(plainObject).not.toHaveProperty('request_id');
    expect(serialized?.['err']).toEqual({ name: 'AppError', message: 'boom', code: 'X' });
    expect(text?.['err']).toEqual({ name: 'NonError', message: 'plain' });
    expect(field?.['error']).toEqual({ reason: 'x' });
    expect(field).not.toHaveProperty('err');
  });

  it('redacts keys, Secret values and registered literals in fields, message and the line', () => {
    const registry = new SecretRegistry({ now: () => 0 });
    registry.add('hunter2');
    const { logger, lines } = jsonLogger({ redactor: createRedactor(registry) });
    logger.info('login hunter2', {
      password: 'x',
      boxed: secret('t'),
      note: 'pw is hunter2',
      err: new Error('hunter2 leaked'),
    });
    const line = lines[0] ?? '';
    expect(line).not.toContain('hunter2');
    expect(line).toContain(`"password":"${REDACTED}"`);
    expect(line).toContain('"boxed":"[secret]"');
  });

  it('feeds the ring buffer with every level but keeps trace out of the stream', () => {
    const ring = createRingBuffer(10);
    const { logger, parsed } = jsonLogger({ level: 'trace', ringBuffer: ring });
    logger.trace('payload', { bytes: 1 });
    logger.info('visible');
    expect(ring.size).toBe(2);
    expect(parsed().map((r) => r['msg'])).toEqual(['visible']);
    const verbose = jsonLogger({ level: 'trace', traceLeavesRing: true });
    verbose.logger.trace('payload');
    expect(verbose.parsed().map((r) => r['msg'])).toEqual(['payload']);
  });

  it('never throws from a log call even when a sink throws, and disables it after 10 failures', () => {
    const disabled: string[] = [];
    const { logger } = jsonLogger({
      stream: {
        write: () => {
          throw new Error('EPIPE');
        },
      },
      onSinkDisabled: (f) => disabled.push(f.sink),
    });
    for (let i = 0; i < 12; i += 1) expect(() => logger.info('x')).not.toThrow();
    expect(disabled).toEqual(['stream']);
  });

  it('supports runtime sinks and flush', async () => {
    const { logger } = jsonLogger();
    const seen: string[] = [];
    logger.addSink({ name: 'mem', write: (r) => seen.push(r.msg) });
    logger.warn('one');
    logger.removeSink('mem');
    logger.warn('two');
    expect(seen).toEqual(['one']);
    await expect(logger.flush()).resolves.toBeUndefined();
  });

  it('renders pretty when asked', () => {
    const lines: string[] = [];
    const logger = createLogger({
      level: 'info',
      format: 'pretty',
      clock: createFakeClock(0),
      stream: { write: (c: string) => lines.push(c) },
      context: () => undefined,
      traceIds: () => undefined,
      bindings: { transport: 'http' },
    });
    logger.child({ module: 'mcp' }).info('tool call', { tool: 'navigate' });
    expect(lines[0]).toBe(
      '00:00:00.000 INFO  tool call                  tool=navigate module=mcp transport=http\n',
    );
  });

  it('root bindings and child bindings compose, call fields win', () => {
    const { logger, parsed } = jsonLogger({ bindings: { transport: 'stdio', a: 1 } });
    logger.child({ module: 'x', a: 2 }).info('m', { a: 3 });
    expect(parsed()[0]).toMatchObject({ transport: 'stdio', module: 'x', a: 3 });
  });
});
