/** @module cli/production/probes — real host probes for `doctor`, `init` and `version`: Bun and SQLite versions, Chromium installs per driver, port, PATH lookup, disk, file modes, OTLP reachability */
import { existsSync } from 'node:fs';
import { stat, statfs } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { dirname, join } from 'node:path';
import type { Logger } from '@browserhive/core/runtime';
import { z } from 'zod';
import type { BrowserInstall, HostProbes } from '../deps.ts';

const PackageJson = z.object({ version: z.string() });
const SqliteVersionRow = z.object({ v: z.string() });

function packageVersion(name: string): string | null {
  try {
    const require = createRequire(import.meta.url);
    return PackageJson.parse(require(`${name}/package.json`)).version;
  } catch {
    return null;
  }
}

function packageDir(name: string): string | null {
  try {
    return dirname(createRequire(import.meta.url).resolve(`${name}/package.json`));
  } catch {
    return null;
  }
}

async function browserInstall(
  driver: 'playwright' | 'patchright',
  logger: Logger,
): Promise<BrowserInstall> {
  const version = packageVersion(driver);
  if (version === null) return { packageVersion: null, executablePath: null, installed: false };
  try {
    const { DriverResolver } = await import('@browserhive/core/server');
    const resolver = new DriverResolver({ logger });
    const browserType =
      driver === 'playwright'
        ? resolver.stock()
        : resolver.resolveStealth('patchright').browserType;
    const path = browserType.executablePath();
    return {
      packageVersion: version,
      executablePath: path,
      installed: path !== '' && existsSync(path),
    };
  } catch {
    return { packageVersion: version, executablePath: null, installed: false };
  }
}

/**
 * Builds the production probes.
 *
 * @returns The probes.
 */
export function createHostProbes(options: {
  readonly logger: Logger;
  readonly appVersion: string;
}): HostProbes {
  let sqlite: string | undefined;
  return {
    bunVersion: () => Bun.version,
    playwright: () => browserInstall('playwright', options.logger),
    patchright: () => browserInstall('patchright', options.logger),
    portFree: (host, port) =>
      new Promise((resolve) => {
        const server = createServer();
        server.once('error', (err: NodeJS.ErrnoException) => resolve(err.code !== 'EADDRINUSE'));
        server.listen({ host, port, exclusive: true }, () => {
          server.close(() => resolve(true));
        });
      }),
    which: async (command) => Bun.which(command),
    diskFreeBytes: async (path) => {
      let current = path;
      for (let depth = 0; depth < 64; depth += 1) {
        try {
          const fs = await statfs(current);
          return fs.bavail * fs.bsize;
        } catch {
          const parent = dirname(current);
          if (parent === current) return null;
          current = parent;
        }
      }
      return null;
    },
    pathMode: async (path) => {
      try {
        return (await stat(path)).mode & 0o777;
      } catch {
        return null;
      }
    },
    installCommand: (driver) => {
      const dir = packageDir(driver);
      if (dir === null) return null;
      const cli = join(dir, 'cli.js');
      return existsSync(cli) ? { command: process.execPath, args: [cli] } : null;
    },
    sqliteVersion: async () => {
      sqlite ??= await readSqliteVersion(options);
      return sqlite;
    },
    httpReachable: async (url, timeoutMs) => {
      try {
        const response = await fetch(url, {
          method: 'HEAD',
          signal: AbortSignal.timeout(timeoutMs),
        });
        return { ok: true, detail: `HTTP ${response.status}` };
      } catch (err) {
        const name = err instanceof Error ? err.name : '';
        return {
          ok: false,
          detail:
            name === 'TimeoutError'
              ? `no answer within ${timeoutMs} ms`
              : err instanceof Error
                ? err.message
                : 'request failed',
        };
      }
    },
  };
}

/**
 * `select sqlite_version()` through an in-memory database opened by the persistence adapter.
 *
 * @returns The SQLite library version, or `unknown`.
 */
export async function readSqliteVersion(options: {
  readonly logger: Logger;
  readonly appVersion: string;
}): Promise<string> {
  try {
    const persistence = await import('@browserhive/core/persistence');
    const { createSystemClock } = await import('@browserhive/core/runtime');
    const handle = await persistence.openDatabase({
      path: ':memory:',
      dataDir: '.',
      appVersion: options.appVersion,
      clock: createSystemClock(),
      logger: options.logger,
    });
    try {
      return SqliteVersionRow.parse(handle.raw.query('select sqlite_version() as v').get()).v;
    } finally {
      await handle.close();
    }
  } catch {
    return 'unknown';
  }
}
