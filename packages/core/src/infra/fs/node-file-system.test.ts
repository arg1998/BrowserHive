/** @module infra/fs/node-file-system.test — the node adapter honours the port's missing-path contract. */

import { describe, expect, it } from 'bun:test';
import { join } from 'node:path';
import { withTempDir } from '../../../test/helpers/temp-dir.ts';
import { createNodeFileSystem } from './node-file-system.ts';

describe('createNodeFileSystem', () => {
  it('stat/readdir answer null/[] for missing paths and real data otherwise', async () => {
    await withTempDir(async (dir) => {
      const fs = createNodeFileSystem();
      expect(await fs.stat(join(dir, 'nope'))).toBeNull();
      expect(await fs.readdir(join(dir, 'nope'))).toEqual([]);
      await fs.mkdir(join(dir, 'a', 'b'));
      await fs.writeFile(join(dir, 'a', 'b', 'f.txt'), 'hello');
      const s = await fs.stat(join(dir, 'a', 'b', 'f.txt'));
      expect(s?.isFile).toBe(true);
      expect(s?.sizeBytes).toBe(5);
      expect((await fs.stat(join(dir, 'a')))?.isDirectory).toBe(true);
      expect(await fs.readdir(join(dir, 'a'))).toEqual(['b']);
      expect(await fs.readFile(join(dir, 'a', 'b', 'f.txt'))).toBe('hello');
    });
  });

  it('unlink and rm ignore missing paths and remove existing ones', async () => {
    await withTempDir(async (dir) => {
      const fs = createNodeFileSystem();
      await fs.unlink(join(dir, 'missing'));
      await fs.rm(join(dir, 'missing-dir'), { recursive: true });
      await fs.mkdir(join(dir, 'd'));
      await fs.writeFile(join(dir, 'd', 'x'), '1');
      await fs.unlink(join(dir, 'd', 'x'));
      expect(await fs.stat(join(dir, 'd', 'x'))).toBeNull();
      await fs.writeFile(join(dir, 'd', 'y'), '1');
      await fs.rm(join(dir, 'd'), { recursive: true });
      expect(await fs.stat(join(dir, 'd'))).toBeNull();
    });
  });
});
