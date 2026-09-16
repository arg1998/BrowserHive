/** @module contracts/test/config.parsers — table tests for every value grammar */
import { describe, expect, it } from 'bun:test';
import type { z } from 'zod';
import {
  formatBytes,
  formatDuration,
  formatLevelSpec,
  grammarOf,
  isIPv6,
  isLoopbackHost,
  reservedMessage,
  zBool,
  zBytes,
  zDuration,
  zHost,
  zInt,
  zLevelSpec,
  zList,
  zMap,
  zMaxSessions,
  zPath,
  zPort,
  zRatio,
  zReservedEnum,
  zUrl,
} from '../src/config/index.ts';

type Row = readonly [input: unknown, expected: unknown | typeof REJECT];
const REJECT = Symbol('reject');

function table(name: string, schema: z.ZodType, rows: readonly Row[]): void {
  describe(name, () => {
    for (const [input, expected] of rows) {
      it(`${JSON.stringify(input)} → ${expected === REJECT ? 'reject' : JSON.stringify(expected)}`, () => {
        const result = schema.safeParse(input);
        if (expected === REJECT) {
          expect(result.success).toBe(false);
          expect(result.error?.issues[0]?.message).toContain('Expected');
        } else {
          expect(result.success).toBe(true);
          expect(result.data).toEqual(expected);
        }
      });
    }
  });
}

table('zBool', zBool, [
  ['true', true],
  ['FALSE', false],
  ['1', true],
  ['0', false],
  ['yes', true],
  ['No', false],
  [true, true],
  [false, false],
  ['maybe', REJECT],
  ['', REJECT],
]);

table('zDuration', zDuration, [
  ['2h', 7_200_000],
  ['30m', 1_800_000],
  ['90s', 90_000],
  ['500ms', 500],
  ['1d', 86_400_000],
  ['1500', 1500],
  [1500, 1500],
  [0, 0],
  ['2 hours', REJECT],
  ['-1', REJECT],
  [1.5, REJECT],
  ['', REJECT],
]);

table('zBytes', zBytes, [
  ['2GiB', 2 * 1024 ** 3],
  ['64MiB', 64 * 1024 ** 2],
  ['500MB', 500_000_000],
  ['1KB', 1000],
  ['10B', 10],
  ['4096', 4096],
  [4096, 4096],
  ['1.5GiB', REJECT],
  ['1TB', REJECT],
]);

table('zPort', zPort, [
  ['9876', 9876],
  [1, 1],
  [65535, 65535],
  [0, REJECT],
  ['70000', REJECT],
  ['abc', REJECT],
]);
table('zInt(1)', zInt(1), [
  ['7', 7],
  [7, 7],
  [0, REJECT],
  ['x', REJECT],
]);
table('zRatio', zRatio, [
  ['0.5', 0.5],
  [1, 1],
  [0, 0],
  ['1.1', REJECT],
  ['', REJECT],
]);

table('zHost', zHost, [
  ['127.0.0.1', '127.0.0.1'],
  ['0.0.0.0', '0.0.0.0'],
  ['::1', '::1'],
  ['[::1]', '::1'],
  ['::', '::'],
  ['fe80::1%eth0', REJECT],
  ['localhost', 'localhost'],
  ['127.evil.example', '127.evil.example'],
  ['my-host.local.', 'my-host.local.'],
  ['-bad', REJECT],
  ['', REJECT],
  ['a b', REJECT],
  ['999.1.1.1', REJECT],
]);

table('zPath', zPath, [
  ['./blocklist.txt', './blocklist.txt'],
  ['  ', REJECT],
]);
table('zUrl', zUrl, [
  ['http://127.0.0.1:4318', 'http://127.0.0.1:4318'],
  ['https://collector.example/v1', 'https://collector.example/v1'],
  ['ftp://x', REJECT],
  ['collector:4318', REJECT],
  ['', REJECT],
]);

table('zList', zList, [
  ['a, b ,c', ['a', 'b', 'c']],
  [
    ['a', 'b'],
    ['a', 'b'],
  ],
  ['', []],
  ['a,,b', REJECT],
  ['a,', REJECT],
]);
table('zMap', zMap, [
  ['Authorization=Bearer x=y,Other=1', { Authorization: 'Bearer x=y', Other: '1' }],
  [{ a: 'b' }, { a: 'b' }],
  ['', {}],
  ['novalue', REJECT],
  ['=v', REJECT],
]);

table('zLevelSpec', zLevelSpec, [
  ['info', { root: 'info', modules: {} }],
  ['info,sessions=debug,http=warn', { root: 'info', modules: { sessions: 'debug', http: 'warn' } }],
  ['trace', { root: 'trace', modules: {} }],
  [
    { root: 'warn', modules: { db: 'trace' } },
    { root: 'warn', modules: { db: 'trace' } },
  ],
  ['verbose', REJECT],
  ['info,sessions', REJECT],
  ['info,Sessions=debug', REJECT],
  ['info,sessions=loud', REJECT],
]);

table('zMaxSessions', zMaxSessions, [
  ['8', 8],
  [8, 8],
  ['unbounded', 'unbounded'],
  ['Infinity', 'unbounded'],
  ['0', REJECT],
  [1.5, REJECT],
  ['many', REJECT],
]);

describe('reserved enums', () => {
  const schema = zReservedEnum(['off', 'bitwarden'], ['local', 'onepassword', 'http']);
  it('accepts live members, rejects reserved ones with the reserved message', () => {
    expect(schema.parse('bitwarden')).toBe('bitwarden');
    expect(schema.safeParse('local').error?.issues[0]?.message).toBe(reservedMessage('local'));
    expect(reservedMessage('proxy')).toBe(
      "'proxy' is reserved for a future release and cannot be set.",
    );
    expect(schema.safeParse('keepass').error?.issues[0]?.message).toContain(
      'Expected one of: off, bitwarden',
    );
  });
});

describe('grammars and canonical rendering', () => {
  it('every parser carries a grammar string', () => {
    for (const p of [
      zBool,
      zDuration,
      zBytes,
      zPort,
      zHost,
      zPath,
      zList,
      zMap,
      zUrl,
      zLevelSpec,
      zMaxSessions,
    ]) {
      expect(typeof grammarOf(p)).toBe('string');
    }
    expect(grammarOf(zDuration)).toBe(
      "a duration like '2h', '30m', '90s', '500ms', or an integer of milliseconds",
    );
  });
  it('formats durations, sizes and level specs canonically', () => {
    expect(formatDuration(7_200_000)).toBe('2h');
    expect(formatDuration(1500)).toBe('1500ms');
    expect(formatDuration(0)).toBe('0ms');
    expect(formatBytes(2 * 1024 ** 3)).toBe('2GiB');
    expect(formatBytes(1500)).toBe('1500B');
    expect(formatLevelSpec({ root: 'info', modules: { sessions: 'debug' } })).toBe(
      'info,sessions=debug',
    );
  });
  it('isLoopbackHost follows the shared definition', () => {
    for (const host of ['localhost', 'LOCALHOST', '127.0.0.1', '127.1.2.3', '::1', '[::1]']) {
      expect(isLoopbackHost(host)).toBe(true);
    }
    for (const host of ['0.0.0.0', '::', '127.evil.example', '10.0.0.1', 'fe80::1']) {
      expect(isLoopbackHost(host)).toBe(false);
    }
    expect(isIPv6('::ffff:192.168.0.1')).toBe(true);
    expect(isIPv6('1:2:3:4:5:6:7:8')).toBe(true);
    expect(isIPv6('1:2:3:4:5:6:7:8:9')).toBe(false);
    expect(isIPv6('1::2::3')).toBe(false);
  });
});
