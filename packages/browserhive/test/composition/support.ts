/** @module test/composition/support — temp data dirs, captured output sinks and resolved config bundles for the composition suites. */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ConfigOverrides, ResolvedConfigBundle } from '@browserhive/core/config';
import { resolveConfig } from '@browserhive/core/config';
import type { BootInput, OutputSinks } from '../../src/composition/index.ts';
import { buildHostEnvironment, LOG_MODULES, nodeConfigFs } from '../../src/composition/index.ts';

/** A temp directory removed by `cleanup()`. */
export function tempDir(prefix = 'bh-comp-'): { path: string; cleanup(): void } {
  const path = mkdtempSync(join(tmpdir(), prefix));
  return { path, cleanup: () => rmSync(path, { recursive: true, force: true }) };
}

/** Output sinks that collect lines. */
export interface CapturedOutput extends OutputSinks {
  readonly out: string[];
  readonly err: string[];
}

/** Collecting output sinks (non-TTY). */
export function captureOutput(): CapturedOutput {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    stdout: (line) => out.push(line),
    stderr: (line) => err.push(line),
    isTty: { stdout: false, stderr: false },
  };
}

/** Resolves a config bundle from programmatic overrides with an isolated env and no config file. */
export function resolvedFor(
  overrides: ConfigOverrides,
  env: Readonly<Record<string, string | undefined>> = {},
): ResolvedConfigBundle {
  const result = resolveConfig({
    argv: [],
    env,
    cwd: tmpdir(),
    host: buildHostEnvironment({ env, totalMemoryBytes: 8 * 1024 ** 3 }),
    fs: nodeConfigFs,
    configFile: false,
    overrides,
    knownLogModules: LOG_MODULES,
  });
  if (!result.ok) throw new Error(result.error.render());
  return result.value;
}

/** A `BootInput` for an http server on an ephemeral port in `dataDir` (logs at warn to keep suites quiet). */
export function bootInputFor(
  dataDir: string,
  overrides: ConfigOverrides = {},
  output: CapturedOutput = captureOutput(),
): BootInput & { readonly output: CapturedOutput } {
  const env = {};
  return {
    resolved: resolvedFor(
      {
        port: 0,
        dataDir,
        logLevel: 'warn',
        // The weekly drift job runs the real-browser suites against the installed Chrome.
        ...(process.env['BHDEV_TEST_CHANNEL'] === 'chrome' && { defaultChannel: 'chrome' }),
        ...overrides,
      },
      env,
    ),
    host: buildHostEnvironment({ env, totalMemoryBytes: 8 * 1024 ** 3 }),
    output,
    env,
    appVersion: '0.0.0-test',
    installProcessHandlers: false,
  };
}

/** The global console, reached without naming it: these suites write to it on purpose. */
export const globalConsole: Pick<Console, 'log' | 'error'> = Reflect.get(globalThis, 'console');
