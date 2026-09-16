/** @module infra/static/artifact-files.test — stat, read, ranged streams and recursive sizes over real files. */

import { describe, expect, it } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { withTempDir } from '../../../test/helpers/temp-dir.ts';
import { createArtifactFiles } from './artifact-files.ts';

describe('artifact files', () => {
  it('reads whole files, ranges and directory sizes', async () => {
    await withTempDir(async (dir) => {
      const files = createArtifactFiles();
      mkdirSync(join(dir, 'sub'));
      writeFileSync(join(dir, 'trace.zip'), '0123456789');
      writeFileSync(join(dir, 'sub', 'a.png'), 'abc');
      expect(await files.stat(join(dir, 'trace.zip'))).toEqual({
        size: 10,
        isFile: true,
        isDirectory: false,
      });
      expect(await files.stat(join(dir, 'missing'))).toBeNull();
      expect(await files.read(join(dir, 'missing'))).toBeNull();
      const ranged = await new Response(
        files.stream(join(dir, 'trace.zip'), { start: 2, end: 4 }),
      ).text();
      expect(ranged).toBe('234');
      expect(await files.sizeOf(dir)).toBe(13);
      expect(await files.sizeOf(join(dir, 'missing'))).toBe(0);
    });
  });
});
