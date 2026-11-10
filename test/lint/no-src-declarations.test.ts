/** @module test/lint/no-src-declarations — no declaration file is committed beside the sources (a stray `tsc` emit goes stale with the next edit and can shadow the `.ts` it came from); the generated database types are the one exception. */
import { describe, expect, it } from 'bun:test';
import { resolve } from 'node:path';

const ROOT = resolve(import.meta.dir, '../..');
const ALLOWED = new Set(['packages/core/src/infra/persistence/generated/db.d.ts']);

describe('declarations beside sources', () => {
  it('are never tracked under packages/*/src', () => {
    const listed = Bun.spawnSync(['git', 'ls-files', '--', 'packages/*/src/**'], { cwd: ROOT });
    const files = new TextDecoder()
      .decode(listed.stdout)
      .split('\n')
      .filter((f) => /\.d\.ts(\.map)?$/.test(f) && !ALLOWED.has(f));
    expect(files).toEqual([]);
  });
});
