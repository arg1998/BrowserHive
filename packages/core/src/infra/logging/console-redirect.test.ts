/** @module infra/logging/console-redirect.test — every console method lands in the logger; restore is once-only. */

import { describe, expect, it } from 'bun:test';
import { createCollectingLogger } from './collecting-logger.ts';
import {
  describeConsoleCall,
  type RedirectableConsole,
  redirectConsoleToLogger,
} from './console-redirect.ts';

function fakeConsole(): { target: RedirectableConsole; calls: string[] } {
  const calls: string[] = [];
  const mk =
    (name: string) =>
    (...args: unknown[]) =>
      calls.push(`${name}:${args.join(' ')}`);
  return {
    calls,
    target: {
      log: mk('log'),
      info: mk('info'),
      debug: mk('debug'),
      warn: mk('warn'),
      error: mk('error'),
      trace: mk('trace'),
    },
  };
}

describe('describeConsoleCall', () => {
  it('strips a library tag, splits event/detail, caps detail', () => {
    expect(describeConsoleCall(['[mcp-proxy] establishing stream', 'x'])).toEqual({
      event: 'establishing stream x',
    });
    const withStack = describeConsoleCall([
      `[FastMCP warning] boom\n  at a\n  at b ${'y'.repeat(400)}`,
    ]);
    expect(withStack.event).toBe('boom');
    expect(withStack.detail?.startsWith('at a at b')).toBe(true);
    expect(withStack.detail?.length).toBe(300);
    expect(describeConsoleCall([])).toEqual({ event: '(empty)' });
    expect(describeConsoleCall([new Error('err'), { a: 1 }, undefined]).event).toContain(
      'Error: err',
    );
  });
});

describe('redirectConsoleToLogger', () => {
  it('captures every method unconditionally at the mapped level', () => {
    const log = createCollectingLogger();
    const { target, calls } = fakeConsole();
    const restore = redirectConsoleToLogger(log, target);
    target.log('plain line');
    target.info('[mcp-proxy] lib');
    target.debug('d');
    target.trace('t');
    target.warn('w');
    target.error('e');
    expect(calls).toEqual([]);
    expect(log.records.map((r) => [r.level, r.fields['method'], r.fields['event']])).toEqual([
      ['debug', 'log', 'plain line'],
      ['debug', 'info', 'lib'],
      ['debug', 'debug', 'd'],
      ['debug', 'trace', 't'],
      ['warn', 'warn', 'w'],
      ['error', 'error', 'e'],
    ]);
    expect(log.records[0]?.msg).toBe('console output');
    expect(log.records[0]?.bindings['module']).toBe('system.console');
    restore();
    restore();
    target.log('after');
    expect(calls).toEqual(['log:after']);
  });
});
