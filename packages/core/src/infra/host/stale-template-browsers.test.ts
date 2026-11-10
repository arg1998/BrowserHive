/** @module infra/host/stale-template-browsers.test — which processes are stale template browsers, and the lock sweep. */

import { describe, expect, it } from 'bun:test';
import { mkdir, mkdtemp, readlink, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { staleTemplatePids, sweepStaleTemplateBrowsers } from './stale-template-browsers.ts';

describe('stale template browsers', () => {
  it('matches a --user-data-dir inside the templates directory only', () => {
    const root = join(tmpdir(), 'bh-data', 'templates');
    const pids = staleTemplatePids(
      [
        {
          pid: 1,
          command: `chrome --type=browser --user-data-dir=${join(root, 'tp-a', 'userdata')} about:blank`,
        },
        { pid: 2, command: `chrome --user-data-dir="${join(root, 'tp b', 'userdata')}"` },
        { pid: 3, command: `chrome --user-data-dir=${root}-old/tp-a/userdata` },
        { pid: 4, command: 'chrome --user-data-dir=/elsewhere/profile' },
        { pid: 5, command: `bun ${root}/script.ts` },
        { pid: 6, command: `chrome --user-data-dir=${join(root, 'tp-a', 'userdata')}` },
      ],
      root,
      6,
    );
    expect(pids).toEqual([1, 2]);
  });

  it('kills stale browsers and removes a dead lock of this machine only', async () => {
    const root = await mkdtemp(join(tmpdir(), 'bh-stale-'));
    for (const id of ['tp-dead', 'tp-live', 'tp-other'])
      await mkdir(join(root, id, 'userdata'), { recursive: true });
    await symlink('box-999999', join(root, 'tp-dead', 'userdata', 'SingletonLock'));
    await symlink('box-1234', join(root, 'tp-live', 'userdata', 'SingletonLock'));
    await symlink('other-999999', join(root, 'tp-other', 'userdata', 'SingletonLock'));
    const killed: number[] = [];
    const pids = await sweepStaleTemplateBrowsers(root, {
      listProcesses: async () => [
        { pid: 77, command: `chrome --user-data-dir=${join(root, 'tp-x', 'userdata')}` },
      ],
      kill: (pid) => killed.push(pid),
      alive: (pid) => pid === 1234,
      host: 'box',
    });
    expect(pids).toEqual([77]);
    expect(killed).toEqual([77]);
    await expect(readlink(join(root, 'tp-dead', 'userdata', 'SingletonLock'))).rejects.toThrow();
    expect(await readlink(join(root, 'tp-live', 'userdata', 'SingletonLock'))).toBe('box-1234');
    expect(await readlink(join(root, 'tp-other', 'userdata', 'SingletonLock'))).toBe(
      'other-999999',
    );
  });
});

describe('stale template browsers: paths with spaces (PR #76 F8)', () => {
  it('finds a stale host under the macOS default data dir', () => {
    const root = '/Users/amir/Library/Application Support/BrowserHive/templates';
    const ps = [
      {
        pid: 4242,
        command: `/Applications/Chromium.app/Contents/MacOS/Chromium --disable-sync --user-data-dir=${root}/tp-1/userdata --remote-debugging-pipe about:blank`,
      },
      { pid: 5, command: `chrome --user-data-dir=${root} Old/tp-1/userdata` },
    ];
    expect(staleTemplatePids(ps, root, 1)).toEqual([4242]);
  });

  it('finds a quoted switch with a spaced Windows path', () => {
    const root = 'C:\\Users\\John Smith\\AppData\\Local\\BrowserHive\\templates';
    const ps = [
      { pid: 7, command: `"C:\\chrome.exe" "--user-data-dir=${root}\\tp-1\\userdata" --x` },
    ];
    expect(staleTemplatePids(ps, root, 1)).toEqual([7]);
  });

  it('kills a stale host in a real temp dir whose name contains a space', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'bh stale '));
    const root = join(parent, 'templates');
    await mkdir(join(root, 'tp-a', 'userdata'), { recursive: true });
    const killed: number[] = [];
    const pids = await sweepStaleTemplateBrowsers(root, {
      listProcesses: async () => [
        { pid: 91, command: `chrome --user-data-dir=${join(root, 'tp-a', 'userdata')} --x` },
      ],
      kill: (pid) => killed.push(pid),
      alive: () => false,
      host: 'box',
    });
    expect(pids).toEqual([91]);
    expect(killed).toEqual([91]);
  });
});
