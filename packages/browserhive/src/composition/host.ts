/** @module composition/host — the ONE place process facts are read: `buildHostEnvironment` (the `ports/host-environment.ts` shape) and the browser adapter's `HostFacts` slice. */

import { arch, cpus, homedir, platform, release, tmpdir, totalmem } from 'node:os';
import type { HostEnvironment } from '@browserhive/core/runtime';
import { LOG_MODULES } from '@browserhive/core/runtime';

export { LOG_MODULES };

/** Process facts `buildHostEnvironment` reads; every field defaults to the running process. */
export interface ProcessFacts {
  /** Environment variables (default `process.env`); `{}` isolates a programmatic server. */
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly platform?: string;
  readonly arch?: string;
  /** `os.release()` (kernel / Darwin / Windows build). */
  readonly release?: string;
  readonly homeDir?: string;
  readonly tmpDir?: string;
  /** Host RAM in bytes; `createServer({ hostMemory })` overrides it for tests. */
  readonly totalMemoryBytes?: number;
  readonly cpuCount?: number;
  readonly isTty?: { readonly stdout: boolean; readonly stderr: boolean };
}

/** The browser adapter's slice of the host (`infra/browsers/host-facts.ts`). */
export type HostFacts = Pick<HostEnvironment, 'platform' | 'arch' | 'release' | 'env'>;

/**
 * Builds the injected {@link HostEnvironment}. Below the composition root nothing reads
 * `process.env` or `node:os`; this builder is the only place that does.
 * The env record is a frozen copy, so later mutations of `process.env` never leak in.
 */
export function buildHostEnvironment(proc: ProcessFacts = {}): HostEnvironment {
  const env = proc.env ?? processEnv();
  return Object.freeze({
    platform: proc.platform ?? platform(),
    arch: proc.arch ?? arch(),
    release: proc.release ?? release(),
    homeDir: proc.homeDir ?? homedir(),
    tmpDir: proc.tmpDir ?? tmpdir(),
    totalMemoryBytes: proc.totalMemoryBytes ?? totalmem(),
    cpuCount: proc.cpuCount ?? Math.max(1, cpus().length),
    isTty: Object.freeze({
      stdout: proc.isTty?.stdout ?? process.stdout.isTTY === true,
      stderr: proc.isTty?.stderr ?? process.stderr.isTTY === true,
    }),
    env: Object.freeze({ ...env }),
  });
}

/** The running process's environment (the default env layer of the CLI and `createServer`). */
export function processEnv(): Readonly<Record<string, string | undefined>> {
  return process.env;
}

/** Maps the host record onto the `HostFacts` the Playwright driver and the geo seed resolver read. */
export function hostFactsOf(host: HostEnvironment): HostFacts {
  return { platform: host.platform, arch: host.arch, release: host.release, env: host.env };
}
