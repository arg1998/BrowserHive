/** @module infra/desktop/bun-desktop.test — desktop detection, argv-only opener, honest failure reasons. */

import { describe, expect, it } from 'bun:test';
import type { ProcessRunner } from '../../ports/process-runner.ts';
import { createBunDesktop } from './bun-desktop.ts';

function runner(
  code: number | null,
  calls: { command: string; args: readonly string[] }[],
): ProcessRunner {
  return {
    run: async (command, args) => {
      calls.push({ command, args });
      return { code, stdout: '', stderr: code === 0 ? '' : 'no handler', timedOut: false };
    },
  };
}

describe('bun desktop', () => {
  it('opens with xdg-open on a graphical Linux host, the path as one argv entry', async () => {
    const calls: { command: string; args: readonly string[] }[] = [];
    const desktop = createBunDesktop({
      runner: runner(0, calls),
      platform: 'linux',
      env: { DISPLAY: ':0' },
      isDirectory: async () => true,
    });
    const result = await desktop.reveal('/data/sessions/a b; rm -rf');
    expect(result).toEqual({
      path: '/data/sessions/a b; rm -rf',
      exists: true,
      desktop: true,
      opened: true,
    });
    expect(calls).toEqual([{ command: 'xdg-open', args: ['/data/sessions/a b; rm -rf'] }]);
  });

  it('reports missing before no_desktop, and failed with stderr', async () => {
    const calls: { command: string; args: readonly string[] }[] = [];
    const headless = createBunDesktop({
      runner: runner(0, calls),
      platform: 'linux',
      env: {},
      isDirectory: async () => false,
    });
    expect((await headless.reveal('/x')).reason).toBe('missing');
    const noDisplay = createBunDesktop({
      runner: runner(0, calls),
      platform: 'linux',
      env: {},
      isDirectory: async () => true,
    });
    expect((await noDisplay.reveal('/x')).reason).toBe('no_desktop');
    const failing = createBunDesktop({
      runner: runner(3, calls),
      platform: 'darwin',
      env: {},
      isDirectory: async () => true,
    });
    expect(await failing.reveal('/x')).toMatchObject({
      opened: false,
      reason: 'failed',
      detail: 'no handler',
    });
    const windows = createBunDesktop({
      runner: runner(1, calls),
      platform: 'win32',
      env: {},
      isDirectory: async () => true,
    });
    expect((await windows.reveal('C:\\x')).opened).toBe(true);
    expect(calls).toHaveLength(2);
  });
});
