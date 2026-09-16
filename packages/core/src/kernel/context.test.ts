/** @module kernel/context.test — request context propagation across async boundaries. */

import { describe, expect, it } from 'bun:test';
import {
  bindRequestContext,
  currentRequestContext,
  extendRequestContext,
  type RequestContext,
  runWithRequestContext,
} from './context.ts';

const base: RequestContext = {
  traceId: 'a'.repeat(32),
  spanId: 'b'.repeat(16),
  requestId: 'req-1',
  transport: 'http',
};

describe('runWithRequestContext', () => {
  it('is undefined outside any entry point', () => {
    expect(currentRequestContext()).toBeUndefined();
  });

  it('propagates across awaits and timers', async () => {
    const seen = await runWithRequestContext(base, async () => {
      await Promise.resolve();
      await new Promise((r) => setTimeout(r, 1));
      return currentRequestContext();
    });
    expect(seen).toEqual(base);
    expect(currentRequestContext()).toBeUndefined();
  });

  it('isolates concurrent contexts', async () => {
    const results = await Promise.all(
      ['x', 'y', 'z'].map((id) =>
        runWithRequestContext({ ...base, requestId: id }, async () => {
          await new Promise((r) => setTimeout(r, Math.random() * 3));
          return currentRequestContext()?.requestId;
        }),
      ),
    );
    expect(results).toEqual(['x', 'y', 'z']);
  });
});

describe('extendRequestContext', () => {
  it('merges defined keys only', () => {
    runWithRequestContext(base, () => {
      extendRequestContext({ sessionId: 's-1', requestId: undefined }, () => {
        expect(currentRequestContext()).toEqual({ ...base, sessionId: 's-1' });
      });
      expect(currentRequestContext()).toEqual(base);
    });
  });

  it('runs the function unchanged without a current context', () => {
    expect(
      extendRequestContext({ sessionId: 's-1' }, () => currentRequestContext()),
    ).toBeUndefined();
  });
});

describe('bindRequestContext', () => {
  it('restores the captured context when called later', async () => {
    const bound = runWithRequestContext(base, () =>
      bindRequestContext(() => currentRequestContext()?.requestId),
    );
    await new Promise((r) => setTimeout(r, 1));
    expect(bound()).toBe('req-1');
  });

  it('returns the function unchanged when nothing is captured', () => {
    const fn = (): number => 1;
    expect(bindRequestContext(fn)).toBe(fn);
  });
});
