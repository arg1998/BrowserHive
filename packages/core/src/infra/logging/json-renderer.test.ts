/** @module infra/logging/json-renderer.test — key order and whole-line scrubbing. */

import { describe, expect, it } from 'bun:test';
import { renderJson } from './json-renderer.ts';

describe('renderJson', () => {
  it('orders the leading keys and keeps the rest in insertion order', () => {
    const line = renderJson({
      zeta: 1,
      session_id: 's-1',
      msg: 'hello',
      level: 'info',
      ts: 5,
      module: 'm',
      trace_id: 't',
      alpha: 'a',
    });
    expect(Object.keys(JSON.parse(line))).toEqual([
      'ts',
      'level',
      'msg',
      'module',
      'trace_id',
      'session_id',
      'zeta',
      'alpha',
    ]);
  });

  it('scrubs the finished line', () => {
    const line = renderJson({ ts: 1, level: 'info', msg: 'x', module: 'm', note: 'hunter2' }, (l) =>
      l.replaceAll('hunter2', '[REDACTED]'),
    );
    expect(line).toBe('{"ts":1,"level":"info","msg":"x","module":"m","note":"[REDACTED]"}');
  });

  it('never throws on unserializable values', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic['self'] = cyclic;
    const line = renderJson({ ts: 1, level: 'info', msg: 'x', module: 'm', cyclic, big: 10n });
    expect(JSON.parse(line)).toMatchObject({ unserializable: true });
    expect(
      JSON.parse(renderJson({ ts: 1, level: 'info', msg: 'x', module: 'm', big: 10n })),
    ).toMatchObject({ big: '10' });
  });
});
