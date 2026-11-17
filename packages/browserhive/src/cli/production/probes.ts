/** @module cli/production/probes — real host probes for `doctor`, `init` and `version`: Bun and SQLite versions, the driver's Chromium install, port, PATH lookup (and the `bh` shorthand), disk, file modes, OTLP reachability, template state files and profile secrets */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { stat, statfs } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { dirname, join } from 'node:path';
import type { Channel } from '@browserhive/contracts/enums';
import type { Logger } from '@browserhive/core/runtime';
import { z } from 'zod';
import type { BrowserInstall, HostProbes, TemplateStateFileFacts } from '../deps.ts';
import { findShorthand, nodeShorthandFs } from './shorthand.ts';

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

/** Patchright's package and its Chromium (the only driver, D-65). */
async function browserInstall(): Promise<BrowserInstall> {
  const version = packageVersion('patchright');
  if (version === null) return { packageVersion: null, executablePath: null, installed: false };
  try {
    const { driverChromium } = await import('@browserhive/core/server');
    const path = driverChromium().executablePath();
    return {
      packageVersion: version,
      executablePath: path,
      installed: path !== '' && existsSync(path),
    };
  } catch {
    return { packageVersion: version, executablePath: null, installed: false };
  }
}

function readText(path: string): string | null {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

function listDir(path: string): readonly string[] {
  try {
    return readdirSync(path);
  } catch {
    return [];
  }
}

/** The driver's (Playwright API) `channel` for a public channel name. */
const PLAYWRIGHT_CHANNEL: Readonly<Record<Channel, string>> = {
  chromium: 'chromium',
  chrome: 'chrome',
  edge: 'msedge',
};

/** A helper command with a short ceiling; a spawn failure reads as a failed command. */
async function runHelper(
  command: string,
  args: readonly string[],
): Promise<{ readonly code: number | null; readonly stdout: string }> {
  try {
    const child = Bun.spawn([command, ...args], { stdout: 'pipe', stderr: 'ignore' });
    const timer = setTimeout(() => child.kill(), 10_000);
    const stdout = await new Response(child.stdout).text();
    const code = await child.exited;
    clearTimeout(timer);
    return { code, stdout };
  } catch {
    return { code: null, stdout: '' };
  }
}

async function detect() {
  const server = await import('@browserhive/core/server');
  let bundledPath: string | null = null;
  try {
    const path = server.driverChromium().executablePath();
    bundledPath = path !== '' && existsSync(path) ? path : null;
  } catch {
    bundledPath = null;
  }
  return server.detectBrowsers({
    platform: process.platform,
    env: process.env,
    exists: existsSync,
    readFile: readText,
    listDir,
    run: runHelper,
    bundled: { executablePath: bundledPath, version: server.bundledChromiumVersion() },
  });
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
    patchright: () => browserInstall(),
    portFree: (host, port) =>
      new Promise((resolve) => {
        const server = createServer();
        server.once('error', (err: NodeJS.ErrnoException) => resolve(err.code !== 'EADDRINUSE'));
        server.listen({ host, port, exclusive: true }, () => {
          server.close(() => resolve(true));
        });
      }),
    which: async (command) => Bun.which(command),
    shorthand: async () =>
      findShorthand({ platform: process.platform, env: process.env, fs: nodeShorthandFs }),
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
    installCommand: () => {
      const dir = packageDir('patchright');
      if (dir === null) return null;
      const cli = join(dir, 'cli.js');
      return existsSync(cli) ? { command: process.execPath, args: [cli] } : null;
    },
    sqliteVersion: async () => {
      sqlite ??= await readSqliteVersion(options);
      return sqlite;
    },
    browsers: () => detect(),
    sandbox: async (channel) => {
      const server = await import('@browserhive/core/server');
      return server.probeSandbox(server.driverChromium(), {
        playwrightChannel: PLAYWRIGHT_CHANNEL[channel],
      });
    },
    sandboxEnvironment: async () => {
      const server = await import('@browserhive/core/server');
      return server.inspectSandboxEnvironment({
        platform: process.platform,
        uid: typeof process.getuid === 'function' ? process.getuid() : null,
        exists: existsSync,
        readFile: readText,
      });
    },
    templateStateFiles: async (templatesDir) => {
      const server = await import('@browserhive/core/server');
      // No key is needed to list the files and read the key id in each header.
      const store = new server.FileTemplateStateStore({
        templatesDir,
        keys: { current: null, previous: null },
      });
      const facts: TemplateStateFileFacts[] = [];
      for (const templateId of await store.templatesWithFiles()) {
        for (const file of await store.files(templateId)) {
          const name = file.slot === 'latest' ? 'latest.state.enc' : `v${file.slot}.state.enc`;
          facts.push({ templateId, file: name, keyId: file.keyId });
        }
      }
      return facts;
    },
    profileHasSecrets: async (userDataDir) => {
      const server = await import('@browserhive/core/server');
      return server.profileHasSecrets(userDataDir);
    },
    apparmorCovers: async (path) => {
      const server = await import('@browserhive/core/server');
      return server.apparmorProfileCovers(path, {
        platform: process.platform,
        listDir,
        readFile: readText,
      });
    },
    fetchOnce: async (url, timeoutMs) => {
      try {
        const response = await fetch(url, {
          method: 'GET',
          redirect: 'manual',
          signal: AbortSignal.timeout(timeoutMs),
        });
        const text = await response.text();
        return {
          kind: 'response',
          status: response.status,
          contentType: response.headers.get('content-type'),
          location: response.headers.get('location'),
          body: text.slice(0, 64 * 1024),
        };
      } catch (err) {
        const name = err instanceof Error ? err.name : '';
        return {
          kind: 'error',
          detail:
            name === 'TimeoutError'
              ? `no answer within ${timeoutMs} ms`
              : err instanceof Error
                ? err.message
                : 'request failed',
        };
      }
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
