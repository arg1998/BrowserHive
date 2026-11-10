/** @module infra/fs/template-files — `node:fs` adapter of the `TemplateFiles` port. */

import { lstat, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { TemplateFiles } from '../../ports/template-files.ts';

function isMissing(error: unknown): boolean {
  return (
    error !== null &&
    typeof error === 'object' &&
    'code' in error &&
    (error.code === 'ENOENT' || error.code === 'ENOTDIR')
  );
}

/** Bytes of the regular files under `path`; symbolic links count nothing and are not followed. */
async function sizeOf(path: string): Promise<number> {
  let stat: Awaited<ReturnType<typeof lstat>>;
  try {
    stat = await lstat(path);
  } catch (error) {
    if (isMissing(error)) return 0;
    throw error;
  }
  if (stat.isFile()) return stat.size;
  if (!stat.isDirectory()) return 0;
  let total = 0;
  for (const entry of await readdir(path)) total += await sizeOf(join(path, entry));
  return total;
}

/**
 * Builds the production {@link TemplateFiles} over `templatesDir` (`<data-dir>/templates`).
 *
 * @returns The adapter.
 */
export function createTemplateFiles(templatesDir: string): TemplateFiles {
  const dirOf = (templateId: string) => join(templatesDir, templateId);
  return {
    dirOf,
    async removeTemplateDir(templateId: string): Promise<number> {
      const dir = dirOf(templateId);
      const bytes = await sizeOf(dir);
      await rm(dir, { recursive: true, force: true, maxRetries: 3 });
      return bytes;
    },
  };
}
