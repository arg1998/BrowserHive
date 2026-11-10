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
