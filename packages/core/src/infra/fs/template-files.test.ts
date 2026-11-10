/** @module infra/fs/template-files.test — deleting a template's directory: bytes counted without following links, a missing directory is 0. */

import { describe, expect, it } from 'bun:test';
import { existsSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { withTempDir } from '../../../test/helpers/temp-dir.ts';
import { createTemplateFiles } from './template-files.ts';

describe('createTemplateFiles', () => {
  it('removes the directory and reports the bytes of its regular files', async () => {
    await withTempDir(async (dir) => {
      const files = createTemplateFiles(dir);
      const root = files.dirOf('tp-abcdefghij');
      expect(root).toBe(join(dir, 'tp-abcdefghij'));
      mkdirSync(join(root, 'userdata', 'Default'), { recursive: true });
      writeFileSync(join(root, 'userdata', 'Default', 'Cookies'), 'x'.repeat(100));
      writeFileSync(join(root, 'note'), 'abc');
      const outside = join(dir, 'outside');
      mkdirSync(outside);
      writeFileSync(join(outside, 'big'), 'y'.repeat(1000));
      if (process.platform !== 'win32') symlinkSync(outside, join(root, 'userdata', 'link'));
      expect(await files.removeTemplateDir('tp-abcdefghij')).toBe(103);
      expect(existsSync(root)).toBe(false);
      expect(existsSync(join(outside, 'big'))).toBe(true);
    });
  });

  it('a template that never had a directory frees 0 bytes', async () => {
    await withTempDir(async (dir) => {
      expect(await createTemplateFiles(dir).removeTemplateDir('tp-missing000')).toBe(0);
    });
  });
});
