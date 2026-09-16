/** @module kernel/deadline.test — deadlines, signal composition and timeout mapping. */

import { describe, expect, it } from 'bun:test';
import {
  anySignal,
  type DeadlineExceeded,
  isDeadlineExceeded,
  raceSignal,
  timeoutError,
  withDeadline,
} from './deadline.ts';
import { isAppError } from './errors/app-error.ts';

const tick = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe('withDeadline', () => {
  it('aborts with DeadlineExceeded after ms', async () => {
    const deadline = withDeadline(undefined, 5);
    expect(deadline.signal.aborted).toBe(false);
    await tick(15);
    expect(deadline.signal.aborted).toBe(true);
    expect(isDeadlineExceeded(deadline.signal.reason)).toBe(true);
    expect((deadline.signal.reason as DeadlineExceeded).timeoutMs).toBe(5);
  });

  it('follows the parent abort with its reason', () => {
    const parent = new AbortController();
    const deadline = withDeadline(parent.signal, 1000);
    parent.abort(new Error('cancelled'));
    expect(deadline.signal.aborted).toBe(true);
    expect((deadline.signal.reason as Error).message).toBe('cancelled');
    deadline.clear();
  });

  it('is already aborted when the parent is', () => {
    const parent = new AbortController();
    parent.abort('x');
    expect(withDeadline(parent.signal, 1000).signal.reason).toBe('x');
  });

  it('clear() cancels the timer', async () => {
    const deadline = withDeadline(undefined, 5);
    deadline.clear();
    await tick(15);
    expect(deadline.signal.aborted).toBe(false);
  });

  it('supports `using`', async () => {
    let captured: AbortSignal | undefined;
    {
      using deadline = withDeadline(undefined, 5);
      captured = deadline.signal;
    }
    await tick(15);
    expect(captured.aborted).toBe(false);
  });

  it('never fires for a non-finite deadline', async () => {
    const deadline = withDeadline(undefined, Number.POSITIVE_INFINITY);
    await tick(5);
    expect(deadline.signal.aborted).toBe(false);
  });
});

describe('anySignal', () => {
  it('aborts when any input aborts, carrying the first reason', () => {
    const a = new AbortController();
    const b = new AbortController();
    const any = anySignal([a.signal, undefined, b.signal]);
    b.abort('b');
    a.abort('a');
    expect(any.aborted).toBe(true);
    expect(any.reason).toBe('b');
  });

  it('is already aborted when an input is', () => {
    const a = new AbortController();
    a.abort('early');
    expect(anySignal([a.signal]).reason).toBe('early');
  });
});

describe('timeoutError', () => {
  it('maps to WAIT_TIMEOUT with what/timeout_ms', () => {
    const error = timeoutError('navigation', 250);
    expect(isAppError(error, 'WAIT_TIMEOUT')).toBe(true);
    expect(error.details).toEqual({ what: 'navigation', timeout_ms: 250 });
  });
});

describe('raceSignal', () => {
  it('resolves when the promise wins', async () => {
    const deadline = withDeadline(undefined, 100);
    await expect(raceSignal(Promise.resolve(42), deadline.signal, 'x', 100)).resolves.toBe(42);
    deadline.clear();
  });

  it('rejects with WAIT_TIMEOUT when the deadline wins', async () => {
    const deadline = withDeadline(undefined, 5);
    const never = new Promise<number>(() => undefined);
    try {
      await raceSignal(never, deadline.signal, 'drain', 5);
      throw new Error('unreachable');
    } catch (error) {
      expect(isAppError(error, 'WAIT_TIMEOUT')).toBe(true);
      expect(isDeadlineExceeded((error as Error).cause)).toBe(true);
    }
  });

  it('rejects with the cancellation reason on a plain abort', async () => {
    const controller = new AbortController();
    const never = new Promise<number>(() => undefined);
    const pending = raceSignal(never, controller.signal, 'drain', 100);
    controller.abort(new Error('shutdown'));
    await expect(pending).rejects.toThrow('shutdown');
  });
});
