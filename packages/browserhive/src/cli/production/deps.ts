/** @module cli/production/deps — builds the real `CliDeps` from the running process (env, argv, cwd, streams, TTY prompt, filesystem, child processes, composition root) and runs the CLI */
import { copyFile } from 'node:fs/promises';
import { VERSION } from '@browserhive/core';
import { APPLICATION_ID, SCHEMA_VERSION } from '@browserhive/core/persistence';
import {
  createBunProcessRunner,
  createLogger,
  createNodeFileSystem,
  createSystemClock,
  LOG_MODULES,
} from '@browserhive/core/runtime';
import { nodeConfigFs } from '../../composition/config-fs.ts';
import { buildHostEnvironment } from '../../composition/host.ts';
import { acquireDataDirLock, readLiveLock } from '../../composition/lock-file.ts';
import type { CliDeps } from '../deps.ts';
import { processStreams, terminalPrompter } from '../output/process-io.ts';
import { runCli } from '../run.ts';
import { createHostProbes } from './probes.ts';
import { inspectDatabaseFile, openCliStorage } from './storage.ts';

/**
 * The production dependency record. Heavy modules (composition root, persistence, browsers) are
 * imported lazily so `--help` and `--version` stay fast.
 *
 * @returns The deps for {@link runCli}.
 */
export function productionDeps(argv: readonly string[]): CliDeps {
  const env = { ...process.env };
  const streams = processStreams();
  const clock = createSystemClock();
  const host = buildHostEnvironment({ env });
  // Maintenance commands only surface errors from the storage stack; everything else is CLI output.
  const logger = createLogger({
    level: 'error',
    format: 'json',
    clock,
    stream: { write: (chunk: string) => streams.stderr(chunk) },
  });
  const context = { logger, appVersion: VERSION, clock };
  return {
    argv,
    env,
    cwd: process.cwd(),
    host,
    configFs: nodeConfigFs,
    fs: createNodeFileSystem(),
    streams,
    prompt: streams.isTty.stdin ? terminalPrompter() : null,
    clock,
    appVersion: VERSION,
    logModules: LOG_MODULES,
    runner: createBunProcessRunner(),
    bootServer: async (input) => {
      const composition = await import('../../composition/index.ts');
      return composition.bootServer(input);
    },
    openStorage: (input) => openCliStorage(input, context),
    inspectDatabase: (path) => inspectDatabaseFile(path, context),
    copyFile: (from, to) => copyFile(from, to),
    lock: {
      read: (dataDir) => readLiveLock(dataDir),
      acquire: (dataDir, owner) => acquireDataDirLock({ dataDir, owner, now: clock.now() }),
    },
    probes: createHostProbes(context),
    http: async (url, init) =>
      fetch(url, {
        method: init.method,
        headers: init.headers,
        ...(init.body !== undefined && { body: init.body }),
      }),
    schemaVersion: SCHEMA_VERSION,
    applicationId: APPLICATION_ID,
  };
}

/**
 * Process entry: runs the CLI and exits with its code.
 *
 * @returns Never resolves in practice (the process exits).
 */
export async function main(): Promise<void> {
  const code = await runCli(productionDeps(process.argv.slice(2)));
  process.exit(code);
}
