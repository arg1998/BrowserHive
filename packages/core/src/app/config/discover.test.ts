/** @module app/config/discover.test — unit tests for discover */
import { describe, expect, it } from 'bun:test';
import { discoverConfigFile, readConfigFile } from './discover.ts';
import { memoryFs } from './test-support.ts';

const CWD_FILE = '/work/browserhive.config.json';
const DATA_FILE = '/data/browserhive.config.json';

describe('discoverConfigFile', () => {
  it('prefers the explicit path and fails when it is missing', () => {
    const fs = memoryFs({ '/etc/bh.json': '{"port":1}', [CWD_FILE]: '{"port":2}' });
    const found = discoverConfigFile({
      explicit: { path: '/etc/bh.json', location: '--config' },
      cwd: '/work',
      dataDir: '/data',
      fs,
    });
    expect(found).toMatchObject({
      ok: true,
      value: { path: '/etc/bh.json', origin: 'explicit', json: { port: 1 }, mode: 0o600 },
    });
    const missing = discoverConfigFile({
      explicit: { path: '/etc/none.json', location: '--config' },
      cwd: '/work',
      dataDir: '/data',
      fs,
    });
    expect(missing).toEqual({
      ok: false,
      error: {
        code: 'CONFIG_FILE_INVALID',
        source: 'file',
        location: '--config',
        message: 'cannot read /etc/none.json: no such file',
      },
    });
    const dir = discoverConfigFile({
      explicit: { path: '/etc', location: '--config' },
      cwd: '/work',
      dataDir: '/data',
      fs,
    });
    expect(dir).toMatchObject({
      ok: false,
      error: { message: 'cannot read /etc: is a directory' },
    });
  });

  it('falls back to cwd, then the data dir, then nothing', () => {
    const both = memoryFs({ [CWD_FILE]: '{"port":2}', [DATA_FILE]: '{"port":3}' });
    expect(discoverConfigFile({ cwd: '/work', dataDir: '/data', fs: both })).toMatchObject({
      ok: true,
      value: { path: CWD_FILE, origin: 'cwd', json: { port: 2 } },
    });
    const dataOnly = memoryFs({ [DATA_FILE]: '{"port":3}' });
    expect(discoverConfigFile({ cwd: '/work', dataDir: '/data', fs: dataOnly })).toMatchObject({
      ok: true,
      value: { path: DATA_FILE, origin: 'dataDir', json: { port: 3 } },
    });
    expect(discoverConfigFile({ cwd: '/work', dataDir: '/data', fs: memoryFs({}) })).toEqual({
      ok: true,
      value: undefined,
    });
  });
});

describe('readConfigFile', () => {
  it('reports invalid JSON with line and column', () => {
    const fs = memoryFs({ [CWD_FILE]: '{\n  "port": 1,\n}\n' });
    expect(readConfigFile(CWD_FILE, 'cwd', fs)).toEqual({
      ok: false,
      error: {
        code: 'CONFIG_FILE_INVALID',
        source: 'file',
        location: `file:${CWD_FILE}`,
        message: `cannot read ${CWD_FILE}: invalid JSON at line 3, column 1: trailing commas are not allowed`,
      },
    });
  });

  it('requires a top-level object and surfaces read errors', () => {
    expect(readConfigFile(CWD_FILE, 'cwd', memoryFs({ [CWD_FILE]: '[1]' }))).toMatchObject({
      ok: false,
      error: { message: `cannot read ${CWD_FILE}: expected a JSON object at the top level` },
    });
    const throwing = {
      readFile: () => {
        const error: Error & { code?: string } = new Error('EACCES: permission denied');
        error.code = 'EACCES';
        throw error;
      },
      stat: () => undefined,
    };
    expect(readConfigFile(CWD_FILE, 'cwd', throwing)).toMatchObject({
      ok: false,
      error: { message: `cannot read ${CWD_FILE}: permission denied` },
    });
    const plain = {
      readFile: () => {
        throw new Error('disk on fire');
      },
      stat: () => undefined,
    };
    expect(readConfigFile(CWD_FILE, 'cwd', plain)).toMatchObject({
      ok: false,
      error: { message: `cannot read ${CWD_FILE}: disk on fire` },
    });
  });
});
