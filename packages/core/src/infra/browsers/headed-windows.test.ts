/** @module infra/browsers/headed-windows.test — the minimized-window keeper (D-77): new pages' windows minimized, an operator's restore respected, a site's restore not mistaken for one. */

import { describe, expect, it } from 'bun:test';
import { createCollectingLogger } from '../logging/collecting-logger.ts';
import {
  DURING_CALL_MS,
  MinimizedWindows,
  RESTORE_QUIET_MS,
  type WindowControl,
  type WindowState,
} from './headed-windows.ts';

/** Windows by id, targets by id. */
class FakeWindows implements WindowControl {
  readonly windowOfTarget = new Map<string, number>();
  readonly states = new Map<number, WindowState>();
  readonly minimizeCalls: number[] = [];
  async windowOf(targetId: string): Promise<number | null> {
    return this.windowOfTarget.get(targetId) ?? null;
  }
  async stateOf(windowId: number): Promise<WindowState | null> {
    return this.states.get(windowId) ?? null;
  }
  async minimizeWindow(windowId: number): Promise<void> {
    this.minimizeCalls.push(windowId);
    this.states.set(windowId, 'minimized');
  }
  open(targetId: string, windowId: number, state: WindowState): void {
    this.windowOfTarget.set(targetId, windowId);
    this.states.set(windowId, state);
  }
}

function keeper() {
  const windows = new FakeWindows();
  let now = 0;
  const kept = new MinimizedWindows(windows, createCollectingLogger(), {
    now: () => now,
    pollMs: 60_000,
  });
  return {
    windows,
    kept,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe('MinimizedWindows', () => {
  it('minimizes a new page whose window opened normal (a popup)', async () => {
    const { windows, kept } = keeper();
    windows.open('popup', 7, 'normal');
    await kept.pageOpened('popup');
    expect(windows.minimizeCalls).toEqual([7]);
    kept.dispose();
  });

  it('leaves an already minimized window as it is (a window created minimized)', async () => {
    const { windows, kept } = keeper();
    windows.open('first', 1, 'minimized');
    await kept.pageOpened('first');
    expect(windows.minimizeCalls).toEqual([]);
    kept.dispose();
  });

  it('minimizes again a kept window a site restored with a new tab', async () => {
    const { windows, kept, advance } = keeper();
    windows.open('first', 1, 'minimized');
    await kept.pageOpened('first');
    advance(RESTORE_QUIET_MS + 1);
    // A `target=_blank` link: Chromium restores window 1 for the new tab.
    windows.open('tab', 1, 'normal');
    kept.targetCreated();
    await kept.poll(); // within the quiet period: the restore is not the operator's
    expect(kept.restoredByOperator(1)).toBe(false);
    await kept.pageOpened('tab');
    expect(windows.minimizeCalls).toEqual([1]);
    kept.dispose();
  });

  it('leaves a window alone once the operator restored it by hand', async () => {
    const { windows, kept, advance } = keeper();
    windows.open('first', 1, 'minimized');
    await kept.pageOpened('first');
    advance(RESTORE_QUIET_MS + 1);
    windows.states.set(1, 'normal'); // the operator clicks it in the taskbar
    await kept.poll();
    expect(kept.restoredByOperator(1)).toBe(true);
    windows.open('tab', 1, 'normal');
    await kept.pageOpened('tab');
    expect(windows.minimizeCalls).toEqual([]);
    kept.dispose();
  });

  it('forgets closed windows and never throws on unreadable targets', async () => {
    const { windows, kept, advance } = keeper();
    windows.open('first', 1, 'minimized');
    await kept.pageOpened('first');
    windows.states.delete(1);
    advance(RESTORE_QUIET_MS + 1);
    await kept.poll();
    expect(kept.restoredByOperator(1)).toBe(false);
    await kept.pageOpened('unknown');
    expect(windows.minimizeCalls).toEqual([]);
    kept.dispose();
  });

  it('does nothing once disposed', async () => {
    const { windows, kept } = keeper();
    kept.dispose();
    windows.open('popup', 3, 'normal');
    await kept.pageOpened('popup');
    expect(windows.minimizeCalls).toEqual([]);
  });

  it('around: a window an action restored (a click) is minimized again; others are untouched', async () => {
    const { windows, kept } = keeper();
    windows.open('a', 1, 'minimized');
    windows.open('b', 2, 'minimized');
    await kept.pageOpened('a');
    await kept.pageOpened('b');
    const result = await kept.around(
      async () => ['a', 'b'],
      async () => {
        windows.states.set(1, 'normal'); // the click raised window 1
        return 'clicked';
      },
    );
    expect(result).toBe('clicked');
    expect(windows.minimizeCalls).toEqual([1]);
    expect(windows.states.get(2)).toBe('minimized');
    kept.dispose();
  });

  it('around: a kept window found normal before the action is the operator’s and stays restored', async () => {
    const { windows, kept, advance } = keeper();
    windows.open('a', 1, 'minimized');
    await kept.pageOpened('a');
    advance(RESTORE_QUIET_MS + 1);
    windows.states.set(1, 'normal'); // the operator restored it, no poll yet
    await kept.around(
      async () => ['a'],
      async () => undefined,
    );
    expect(kept.restoredByOperator(1)).toBe(true);
    expect(windows.minimizeCalls).toEqual([]);
    kept.dispose();
  });

  it('around: a failing action still minimizes again and rethrows', async () => {
    const { windows, kept } = keeper();
    windows.open('a', 1, 'minimized');
    await kept.pageOpened('a');
    const failing = kept.around(
      async () => ['a'],
      async () => {
        windows.states.set(1, 'normal');
        throw new Error('click failed');
      },
    );
    await expect(failing).rejects.toThrow('click failed');
    expect(windows.minimizeCalls).toEqual([1]);
    kept.dispose();
  });

  it('a poll during or right after an action says nothing about the operator', async () => {
    const { windows, kept, advance } = keeper();
    windows.open('a', 1, 'minimized');
    await kept.pageOpened('a');
    advance(RESTORE_QUIET_MS + 1);
    let polled: Promise<void> = Promise.resolve();
    await kept.around(
      async () => ['a'],
      async () => {
        windows.states.set(1, 'normal');
        polled = kept.poll();
      },
    );
    await polled;
    expect(kept.restoredByOperator(1)).toBe(false);
    kept.dispose();
  });

  it('around: a parallel call never takes the other call’s restore for the operator’s (review #89 F2)', async () => {
    const { windows, kept, advance } = keeper();
    windows.open('a', 1, 'minimized');
    await kept.pageOpened('a');
    advance(RESTORE_QUIET_MS + 1);
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const navigatingClick = kept.around(
      async () => ['a'],
      async () => {
        windows.states.set(1, 'normal'); // the click restored it; the navigation is slow
        await held;
      },
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    advance(RESTORE_QUIET_MS + 1);
    windows.states.set(1, 'normal');
    // A screenshot or snapshot meanwhile.
    await kept.around(
      async () => ['a'],
      async () => undefined,
    );
    expect(kept.restoredByOperator(1)).toBe(false);
    windows.states.set(1, 'normal');
    release();
    await navigatingClick;
    expect(windows.states.get(1)).toBe('minimized');
    kept.dispose();
  });

  it('around: the window is minimized again while the call runs, not only after it (review #89 F1)', async () => {
    const windows = new FakeWindows();
    const kept = new MinimizedWindows(windows, createCollectingLogger(), { duringMs: 5 });
    windows.open('a', 1, 'minimized');
    await kept.pageOpened('a');
    let duringCall = 0;
    await kept.around(
      async () => ['a'],
      async () => {
        windows.states.set(1, 'normal'); // the click's press
        await new Promise((resolve) => setTimeout(resolve, 60)); // its navigation, or typing
        duringCall = windows.minimizeCalls.length;
      },
    );
    expect(duringCall).toBeGreaterThan(0);
    expect(DURING_CALL_MS).toBeLessThanOrEqual(50);
    kept.dispose();
  });

  it('a restore after the quiet period, with no call on the window, is the operator’s (a dialog too)', async () => {
    const { windows, kept, advance } = keeper();
    windows.open('a', 1, 'minimized');
    await kept.around(
      async () => ['a'],
      async () => undefined,
    );
    windows.states.set(1, 'normal');
    await kept.poll(); // within the quiet period after the call: says nothing
    expect(kept.restoredByOperator(1)).toBe(false);
    advance(RESTORE_QUIET_MS + 1);
    await kept.poll();
    expect(kept.restoredByOperator(1)).toBe(true);
    kept.dispose();
  });
  it("re-minimizes a kept window that its first navigation restored (emulated viewport), not an operator's", async () => {
    const { windows, kept, advance } = keeper();
    windows.open('first', 3, 'normal');
    await kept.pageOpened('first');
    expect(windows.states.get(3)).toBe('minimized');
    // Chromium restores it around the first navigation (outside any tool call).
    advance(RESTORE_QUIET_MS + 1);
    windows.states.set(3, 'normal');
    await kept.firstCommit('first');
    expect(windows.states.get(3)).toBe('minimized');
    // A window the operator restored is left alone, also on a later first commit of another page.
    windows.open('other', 4, 'normal');
    await kept.pageOpened('other');
    advance(RESTORE_QUIET_MS + 1);
    windows.states.set(4, 'normal');
    await kept.poll();
    expect(kept.restoredByOperator(4)).toBe(true);
    await kept.firstCommit('other');
    expect(windows.states.get(4)).toBe('normal');
    kept.dispose();
  });
  it("respects an operator's restore made just before the first navigation (verify #91 N2)", async () => {
    const { windows, kept, advance } = keeper();
    windows.open('first', 5, 'normal');
    await kept.pageOpened('first');
    advance(RESTORE_QUIET_MS + 1);
    // The operator restores it from the taskbar, then the agent's first goto starts and commits.
    windows.states.set(5, 'normal');
    await kept.navigationStarting('first');
    await kept.firstCommit('first');
    expect(windows.states.get(5)).toBe('normal');
    expect(kept.restoredByOperator(5)).toBe(true);
    kept.dispose();
  });
});
