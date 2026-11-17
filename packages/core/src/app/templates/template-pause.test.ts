/** @module app/templates/template-pause.test — agents wait while the operator signs in (D-60): open, close and release of a template's sign-in windows, a dead window ends the pause, bounded waits that end in `TEMPLATE_UNAVAILABLE` `paused`, and the `changed` callback on transitions. */

import { beforeEach, describe, expect, it } from 'bun:test';
import { FakeClock } from '../../../test/helpers/fake-clock.ts';
import { until } from '../../../test/helpers/fake-probe-hosts.ts';
import { isAppError } from '../../kernel/errors/app-error.ts';
import { PAUSE_RETRY_AFTER_MS, PAUSE_WAIT_MS, TemplatePause } from './template-pause.ts';

const T = 'tp-a';

let clock: FakeClock;
let dead: Set<string>;
let changed: string[];
let pause: TemplatePause;

beforeEach(() => {
  clock = new FakeClock();
  dead = new Set();
  changed = [];
  pause = new TemplatePause({
    clock,
    alive: (id) => !dead.has(id),
    changed: (id) => changed.push(id),
  });
});

/** Resolves to `'resolved'` or the error code. */
function outcome(promise: Promise<unknown>): { settled: () => string | null } {
  let result: string | null = null;
  promise.then(
    () => {
      result = 'resolved';
    },
    (err: unknown) => {
      result = isAppError(err) ? err.code : 'other';
    },
  );
  return { settled: () => result };
}

describe('open, close and release', () => {
  it('a window pauses the template until it closes; changed fires on each transition', () => {
    expect(pause.paused(T)).toBe(false);
    pause.open(T, 'relogin-1');
    expect(pause.paused(T)).toBe(true);
    expect(pause.paused('tp-other')).toBe(false);
    pause.open(T, 'recording-2');
    expect(changed).toEqual([T]);
    pause.close(T, 'relogin-1');
    expect(pause.paused(T)).toBe(true);
    pause.close(T, 'recording-2');
    expect(pause.paused(T)).toBe(false);
    expect(changed).toEqual([T, T]);
    pause.close(T, 'recording-2');
    expect(changed).toEqual([T, T]);
  });

  it('release lets agents continue until the windows close; a later window pauses again', () => {
    expect(pause.release(T)).toBe(false);
    pause.open(T, 'relogin-1');
    expect(pause.release(T)).toBe(true);
    expect(pause.paused(T)).toBe(false);
    expect(pause.release(T)).toBe(false);
    expect(changed).toEqual([T, T]);
    pause.close(T, 'relogin-1');
    expect(changed).toEqual([T, T]);
    pause.open(T, 'relogin-2');
    expect(pause.paused(T)).toBe(true);
  });

  it('a window opened released does not pause (the urgent override)', () => {
    pause.open(T, 'relogin-1', true);
    expect(pause.paused(T)).toBe(false);
    expect(changed).toEqual([]);
  });

  it('a dead window ends the pause', () => {
    pause.open(T, 'relogin-1');
    dead.add('relogin-1');
    expect(pause.paused(T)).toBe(false);
    // The state is gone: a new window pauses again.
    dead.clear();
    pause.open(T, 'relogin-2');
    expect(pause.paused(T)).toBe(true);
  });
});

describe('wait', () => {
  it('returns at once when not paused', async () => {
    await pause.wait(T, 'job-hunt');
    expect(clock.pendingSleeps).toBe(0);
  });

  it('resolves when the window closes', async () => {
    pause.open(T, 'relogin-1');
    const wait = outcome(pause.wait(T, 'job-hunt'));
    await until(() => clock.pendingSleeps === 1);
    await clock.advance(250);
    await until(() => clock.pendingSleeps === 1);
    expect(wait.settled()).toBeNull();
    pause.close(T, 'relogin-1');
    await clock.advance(250);
    await until(() => wait.settled() !== null);
    expect(wait.settled()).toBe('resolved');
  });

  it('resolves when the operator releases, or when the window dies', async () => {
    pause.open(T, 'relogin-1');
    const released = outcome(pause.wait(T, 'job-hunt'));
    await until(() => clock.pendingSleeps === 1);
    pause.release(T);
    await clock.advance(250);
    await until(() => released.settled() !== null);
    expect(released.settled()).toBe('resolved');

    pause.open('tp-b', 'relogin-2');
    const died = outcome(pause.wait('tp-b', 'other'));
    await until(() => clock.pendingSleeps === 1);
    dead.add('relogin-2');
    await clock.advance(250);
    await until(() => died.settled() !== null);
    expect(died.settled()).toBe('resolved');
  });

  it('throws TEMPLATE_UNAVAILABLE paused with retry_after_ms after maxMs', async () => {
    pause.open(T, 'relogin-1');
    const wait = pause.wait(T, 'job-hunt', undefined, 1_000);
    let caught: unknown = null;
    const done = wait.catch((err: unknown) => {
      caught = err;
    });
    for (let i = 0; i < 4; i++) {
      await until(() => clock.pendingSleeps === 1);
      await clock.advance(250);
    }
    await done;
    expect(isAppError(caught) && caught.code).toBe('TEMPLATE_UNAVAILABLE');
    expect(isAppError(caught) && caught.details).toEqual({
      template: 'job-hunt',
      reason: 'paused',
      retry_after_ms: PAUSE_RETRY_AFTER_MS,
    });
  });

  it('waits PAUSE_WAIT_MS by default', async () => {
    pause.open(T, 'relogin-1');
    const wait = outcome(pause.wait(T, 'job-hunt'));
    await until(() => clock.pendingSleeps === 1);
    for (let t = 0; t < PAUSE_WAIT_MS - 250; t += 250) {
      await clock.advance(250);
      await until(() => clock.pendingSleeps === 1);
    }
    expect(wait.settled()).toBeNull();
    await clock.advance(250);
    await until(() => wait.settled() !== null);
    expect(wait.settled()).toBe('TEMPLATE_UNAVAILABLE');
  });

  it('an aborted call stops waiting with TEMPLATE_UNAVAILABLE', async () => {
    pause.open(T, 'relogin-1');
    const controller = new AbortController();
    const wait = outcome(pause.wait(T, 'job-hunt', controller.signal));
    await until(() => clock.pendingSleeps === 1);
    controller.abort();
    await clock.advance(250);
    await until(() => wait.settled() !== null);
    expect(wait.settled()).toBe('TEMPLATE_UNAVAILABLE');
  });
});
