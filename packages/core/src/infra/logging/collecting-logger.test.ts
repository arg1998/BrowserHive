/** @module infra/logging/collecting-logger.test — the test double records calls with bindings. */

import { describe, expect, it } from 'bun:test';
import { createCollectingLogger } from './collecting-logger.ts';

describe('createCollectingLogger', () => {
  it('captures every level with bindings and fields', () => {
    const log = createCollectingLogger({ bindings: { transport: 'cli' } });
    const child = log.child({ module: 'sessions' });
    child.info('session opened', { sessionId: 's-1' });
    child.trace('payload');
    expect(log.records).toHaveLength(2);
    expect(log.records[0]).toEqual({
      level: 'info',
      msg: 'session opened',
      fields: { sessionId: 's-1' },
      bindings: { transport: 'cli', module: 'sessions' },
      all: { transport: 'cli', module: 'sessions', sessionId: 's-1' },
    });
    expect(log.has('payload')).toBe(true);
    expect(log.find('session opened')).toHaveLength(1);
    expect(log.at('trace')).toHaveLength(1);
    expect(log.messages()).toEqual(['session opened', 'payload']);
    log.clear();
    expect(log.records).toHaveLength(0);
  });

  it('respects a threshold', () => {
    const log = createCollectingLogger({ level: 'warn' });
    log.info('hidden');
    log.warn('shown');
    expect(log.isLevelEnabled('info')).toBe(false);
    expect(log.messages()).toEqual(['shown']);
  });
});
