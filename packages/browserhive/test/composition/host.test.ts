/** @module test/composition/host.test — `buildHostEnvironment` (frozen env copy, overrides) and the browser `HostFacts` slice. */

import { describe, expect, it } from 'bun:test';
import { effectiveMemoryBytes, type ReadText } from '../../src/composition/host.ts';
import { buildHostEnvironment, hostFactsOf, LOG_MODULES } from '../../src/composition/index.ts';

describe('buildHostEnvironment', () => {
  it('freezes a copy of env and honours overrides', () => {
    const env: Record<string, string | undefined> = { LANG: 'de_DE.UTF-8' };
    const host = buildHostEnvironment({
      env,
      platform: 'linux',
      arch: 'arm64',
      release: '6.8.0',
      totalMemoryBytes: 1024,
      isTty: { stdout: true, stderr: false },
    });
    env['LANG'] = 'C';
    expect(host.env['LANG']).toBe('de_DE.UTF-8');
    expect(Object.isFrozen(host.env)).toBe(true);
    expect(host.totalMemoryBytes).toBe(1024);
    expect(host.isTty).toEqual({ stdout: true, stderr: false });
    expect(hostFactsOf(host)).toEqual({
      platform: 'linux',
      arch: 'arm64',
      release: '6.8.0',
      env: host.env,
    });
  });

  it('fills defaults from the running process', () => {
    const host = buildHostEnvironment({ env: {} });
    expect(host.cpuCount).toBeGreaterThan(0);
    expect(host.homeDir.length).toBeGreaterThan(0);
    expect(host.tmpDir.length).toBeGreaterThan(0);
    expect(LOG_MODULES).toContain('sessions');
  });
});

const GIB = 1024 ** 3;
const HOST = 32 * GIB;

/** A fake filesystem of cgroup files. */
function files(entries: Record<string, string>): ReadText {
  return (path) => entries[path];
}

describe('effectiveMemoryBytes (cgroup-aware maxSessions input)', () => {
  it('is host RAM when no cgroup sets a limit (v2 "max" all the way up)', () => {
    const read = files({
      '/proc/self/cgroup': '0::/user.slice/user-1000.slice/session-2.scope\n',
      '/sys/fs/cgroup/user.slice/user-1000.slice/session-2.scope/memory.max': 'max\n',
      '/sys/fs/cgroup/user.slice/user-1000.slice/memory.max': 'max\n',
      '/sys/fs/cgroup/user.slice/memory.max': 'max\n',
    });
    expect(effectiveMemoryBytes(HOST, read, 'linux')).toBe(HOST);
  });

  it('caps at a v2 limit on the process cgroup (a container sees itself at "/")', () => {
    const read = files({
      '/proc/self/cgroup': '0::/\n',
      '/sys/fs/cgroup/memory.max': `${4 * GIB}\n`,
    });
    expect(effectiveMemoryBytes(HOST, read, 'linux')).toBe(4 * GIB);
  });

  it('caps at the smallest limit on the way up (systemd MemoryMax= on a parent slice)', () => {
    const read = files({
      '/proc/self/cgroup': '0::/system.slice/browserhive.slice/browserhive.service\n',
      '/sys/fs/cgroup/system.slice/browserhive.slice/browserhive.service/memory.max': `${8 * GIB}`,
      '/sys/fs/cgroup/system.slice/browserhive.slice/memory.max': `${3 * GIB}`,
      '/sys/fs/cgroup/system.slice/memory.max': 'max',
    });
    expect(effectiveMemoryBytes(HOST, read, 'linux')).toBe(3 * GIB);
  });

  it('reads cgroup v1 memory.limit_in_bytes, treating the near-2^63 "unlimited" as no cap', () => {
    const capped = files({
      '/proc/self/cgroup': '12:cpu,cpuacct:/docker/abc\n5:memory:/docker/abc\n',
      '/sys/fs/cgroup/memory/docker/abc/memory.limit_in_bytes': `${2 * GIB}`,
      '/sys/fs/cgroup/memory/docker/memory.limit_in_bytes': '9223372036854771712',
    });
    expect(effectiveMemoryBytes(HOST, capped, 'linux')).toBe(2 * GIB);
    const unlimited = files({
      '/proc/self/cgroup': '5:memory:/\n',
      '/sys/fs/cgroup/memory/memory.limit_in_bytes': '9223372036854771712',
    });
    expect(effectiveMemoryBytes(HOST, unlimited, 'linux')).toBe(HOST);
  });

  it('never exceeds host RAM and ignores unreadable or garbage files', () => {
    const read = files({
      '/proc/self/cgroup': '0::/big\n',
      '/sys/fs/cgroup/big/memory.max': `${64 * GIB}`,
      '/sys/fs/cgroup/memory.max': 'garbage',
    });
    expect(effectiveMemoryBytes(HOST, read, 'linux')).toBe(HOST);
    expect(effectiveMemoryBytes(HOST, files({}), 'linux')).toBe(HOST);
  });

  it('is host RAM off Linux, without reading anything', () => {
    const read: ReadText = () => {
      throw new Error('must not read cgroup files off Linux');
    };
    expect(effectiveMemoryBytes(HOST, read, 'darwin')).toBe(HOST);
    expect(effectiveMemoryBytes(HOST, read, 'win32')).toBe(HOST);
  });
});
