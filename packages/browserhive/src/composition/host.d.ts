/** @module composition/host — the ONE place process facts are read: `buildHostEnvironment` (the `ports/host-environment.ts` shape) and the browser adapter's `HostFacts` slice. */
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
  /**
   * Memory this process may use, in bytes: host RAM capped by any cgroup limit
   * ({@link effectiveMemoryBytes}). `createServer({ hostMemory })` overrides it for tests.
   */
  readonly totalMemoryBytes?: number;
  readonly cpuCount?: number;
  readonly isTty?: {
    readonly stdout: boolean;
    readonly stderr: boolean;
  };
}
/** The browser adapter's slice of the host (`infra/browsers/host-facts.ts`). */
export type HostFacts = Pick<HostEnvironment, 'platform' | 'arch' | 'release' | 'env'>;
/**
 * Builds the injected {@link HostEnvironment}. Below the composition root nothing reads
 * `process.env` or `node:os`; this builder is the only place that does.
 * The env record is a frozen copy, so later mutations of `process.env` never leak in.
 */
export declare function buildHostEnvironment(proc?: ProcessFacts): HostEnvironment;
/** The running process's environment (the default env layer of the CLI and `createServer`). */
export declare function processEnv(): Readonly<Record<string, string | undefined>>;
/** Maps the host record onto the `HostFacts` the Playwright driver and the geo seed resolver read. */
export declare function hostFactsOf(host: HostEnvironment): HostFacts;
/** Reads a text file, `undefined` when it does not exist or cannot be read. */
export type ReadText = (path: string) => string | undefined;
/**
 * The memory this process may actually use: host RAM, capped by the memory limit of the process's
 * cgroup or any ancestor (v2 `memory.max`, v1 `memory.limit_in_bytes`). Without the cap a container
 * or a systemd `MemoryMax=` slice would derive `maxSessions` from RAM it can never get (spec 08
 * §6). Linux only; every other platform, and any unreadable cgroup file, yields host RAM.
 */
export declare function effectiveMemoryBytes(
  hostBytes: number,
  read?: ReadText,
  os?: string,
): number;
//# sourceMappingURL=host.d.ts.map
