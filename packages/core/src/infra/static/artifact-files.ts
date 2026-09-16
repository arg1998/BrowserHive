/** @module infra/static/artifact-files — `ArtifactFiles` over `Bun.file` (trace.zip ranges, screenshots, directory sizes). */

import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { ArtifactFiles } from '../../ports/static-assets.ts';

async function sizeOf(path: string): Promise<number> {
  let info: Awaited<ReturnType<typeof stat>>;
  try {
    info = await stat(path);
  } catch {
    return 0;
  }
  if (info.isFile()) return info.size;
  if (!info.isDirectory()) return 0;
  let total = 0;
  for (const name of await readdir(path).catch(() => [])) total += await sizeOf(join(path, name));
  return total;
}

/** The production artifact reader. */
export function createArtifactFiles(): ArtifactFiles {
  return {
    async stat(path) {
      try {
        const info = await stat(path);
        return { size: info.size, isFile: info.isFile(), isDirectory: info.isDirectory() };
      } catch {
        return null;
      }
    },
    async read(path) {
      const file = Bun.file(path);
      if (!(await file.exists())) return null;
      return new Uint8Array(await file.arrayBuffer());
    },
    stream(path, range) {
      const file = Bun.file(path);
      return (range === undefined ? file : file.slice(range.start, range.end + 1)).stream();
    },
    sizeOf,
  };
}
