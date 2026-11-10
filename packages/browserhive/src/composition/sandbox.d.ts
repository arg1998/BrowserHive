/** @module composition/sandbox — the `sandbox` setting at boot: the process's `SandboxPolicy`, the `sandbox=on` preflight that refuses to start (exit code 3) with guidance computed for this host, and the browser/sandbox facts `/system` reports (plan §3.4, §3.5). */
import type { Provenance, ServerConfig } from '@browserhive/contracts/config';
import type { Channel } from '@browserhive/contracts/enums';
import type { SystemBrowser } from '@browserhive/contracts/http';
import type { Clock, Logger } from '@browserhive/core/runtime';
import type {
  DetectedBrowser,
  DriverResolver,
  SandboxEnvironment,
  SandboxProbeResult,
} from '@browserhive/core/server';
import { SandboxPolicy } from '@browserhive/core/server';
/** Host access; tests replace the probes (no real browser launches). */
export interface SandboxHost {
  readonly environment: () => SandboxEnvironment;
  readonly probe: (channel: Channel) => Promise<SandboxProbeResult>;
  readonly detect: () => Promise<readonly DetectedBrowser[]>;
  readonly executable: (channel: Channel) => string | null;
  readonly apparmorCovers: (path: string) => boolean | null;
}
/** Inputs of {@link buildSandbox}. */
export interface SandboxInput {
  readonly config: Readonly<ServerConfig>;
  readonly provenance: Provenance;
  readonly configFilePath: string | undefined;
  readonly resolver: DriverResolver;
  readonly logger: Logger;
  readonly clock: Clock;
  /** Test seam; defaults to {@link realSandboxHost}. */
  readonly host?: SandboxHost;
}
/** What the rest of the composition uses. */
export interface SandboxWiring {
  readonly policy: SandboxPolicy;
  /** `/system`'s browser block: detection runs once (lazily), verdicts are read live. */
  describe(): Promise<SystemBrowser>;
}
/**
 * The real host: files, `--version`, and headless probe launches through the driver sessions use,
 * so the verdict is recorded for the same executable sessions launch.
 */
export declare function realSandboxHost(
  resolver: DriverResolver,
  config: Pick<ServerConfig, 'stealth' | 'stealthDriver'>,
): SandboxHost;
/** How `sandbox=on` was set, as the operator would type it again (`--sandbox on`). */
export declare function sandboxSetting(
  provenance: Provenance,
  configFilePath: string | undefined,
  mode: string,
): string;
/**
 * Builds the policy and, under `sandbox=on`, runs the boot preflight: one headless launch of the
 * configured browser with the sandbox forced on (about 0.3 s when it fails). On failure every other
 * installed browser is probed so the refusal can say what works on this host.
 *
 * @throws `SANDBOX_UNAVAILABLE` (exit code 3) when `sandbox=on` cannot be honoured; nothing has started.
 */
export declare function buildSandbox(input: SandboxInput): Promise<SandboxWiring>;
//# sourceMappingURL=sandbox.d.ts.map
