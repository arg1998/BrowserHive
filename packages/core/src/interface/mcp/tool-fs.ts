/** @module interface/mcp/tool-fs — the `node:fs/promises` implementation of the tools' filesystem seam. */

import { mkdir, stat, writeFile } from 'node:fs/promises';
import type { ToolFs } from './services.ts';

/** Mode for directories the tools create under the data dir (D-24). */
export const TOOL_DIR_MODE = 0o700;

/** Builds the production {@link ToolFs}. */
export function createNodeToolFs(): ToolFs {
  return {
    async mkdir(dir) {
      await mkdir(dir, { recursive: true, mode: TOOL_DIR_MODE });
    },
    async fileSize(path) {
      return (await stat(path)).size;
    },
    async writeFile(path, data) {
      await writeFile(path, data);
    },
  };
}
