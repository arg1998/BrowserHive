/** @module infra/host/process-tree.test — process-tree RSS for `browserhive.browser.rss_bytes` (spec 10 §7): tree sums, `/proc` and `ps` parsing, and the real reader over this process. */

import { describe, expect, it } from 'bun:test';
import {
  createProcessTreeReader,
  parseProcStatus,
  parsePsTable,
  sumProcessTrees,
} from './process-tree.ts';

describe('sumProcessTrees', () => {
  const table = [
    { pid: 1, ppid: 0, rssBytes: 1_000 },
    { pid: 10, ppid: 1, rssBytes: 100 }, // browser A
    { pid: 11, ppid: 10, rssBytes: 20 }, // zygote
    { pid: 12, ppid: 11, rssBytes: 3 }, // renderer under the zygote
    { pid: 13, ppid: 10, rssBytes: 4 }, // GPU
    { pid: 20, ppid: 1, rssBytes: 200 }, // browser B
    { pid: 21, ppid: 20, rssBytes: 5 },
  ];

  it('sums each root with every descendant, never a sibling tree or the parent', () => {
    expect([...sumProcessTrees(table, [10, 20])]).toEqual([
      [10, 127],
      [20, 205],
    ]);
  });

  it('leaves out roots that are gone and survives a ppid cycle', () => {
    expect([...sumProcessTrees(table, [99])]).toEqual([]);
    const cycle = [
      { pid: 5, ppid: 6, rssBytes: 1 },
      { pid: 6, ppid: 5, rssBytes: 2 },
    ];
    expect(sumProcessTrees(cycle, [5]).get(5)).toBe(3);
  });
});

describe('parsers', () => {
  it('reads PPid and VmRSS from /proc/<pid>/status (kernel threads have no VmRSS)', () => {
    const status = 'Name:\tchrome\nState:\tS (sleeping)\nPPid:\t4242\nVmRSS:\t   90524 kB\n';
    expect(parseProcStatus(7, status)).toEqual({ pid: 7, ppid: 4242, rssBytes: 90_524 * 1024 });
    expect(parseProcStatus(2, 'Name:\tkthreadd\nPPid:\t0\n')).toEqual({
      pid: 2,
      ppid: 0,
      rssBytes: 0,
    });
    expect(parseProcStatus(3, 'garbage')).toBeNull();
  });

  it('reads `ps -A -o pid=,ppid=,rss=` rows in KiB', () => {
    expect(parsePsTable('    1     0  1200\n  501     1   64\n\n bad row\n')).toEqual([
      { pid: 1, ppid: 0, rssBytes: 1200 * 1024 },
      { pid: 501, ppid: 1, rssBytes: 64 * 1024 },
    ]);
  });
});

describe('createProcessTreeReader', () => {
  it('has no reader on Windows', () => {
    expect(createProcessTreeReader('win32')).toBeNull();
  });

  it.if(process.platform === 'linux' || process.platform === 'darwin')(
    'reads the tree of this process',
    async () => {
      const reader = createProcessTreeReader();
      const sums = await reader?.rssOfTrees([process.pid, 2 ** 30]);
      expect(sums?.get(process.pid)).toBeGreaterThan(1024 * 1024);
      expect(sums?.has(2 ** 30)).toBe(false);
      expect((await reader?.rssOfTrees([]))?.size).toBe(0);
    },
  );
});
