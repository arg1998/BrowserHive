/** @module composition/config-fs — the production `ConfigFs` (synchronous `readFile`/`stat`) the config resolver discovers and reads `browserhive.config.json` through. */

import { readFileSync, statSync } from 'node:fs';
import type { ConfigFs } from '@browserhive/core/config';

/** `node:fs` adapter of the resolver's `ConfigFs`. */
export const nodeConfigFs: ConfigFs = {
  readFile: (path) => readFileSync(path, 'utf8'),
  stat: (path) => {
    try {
      const stat = statSync(path);
      return { isFile: stat.isFile(), mode: stat.mode & 0o777 };
    } catch {
      return undefined;
    }
  },
};
