/** @module composition/phases/domain-sessions — browser driver (Patchright resolution per `stealthDriver`), the sandbox policy and its `sandbox=on` preflight, identity/proxy resolvers, blocklist (+ watcher), auth-state store, session service and lease sweeper. */
import type { Provenance, ServerConfig } from '@browserhive/contracts/config';
import type { Clock, DomainEvents, EventBus, IdGenerator, Logger } from '@browserhive/core/runtime';
import type { BlocklistFileWatcher, HostFacts } from '@browserhive/core/server';
import {
  AuthStateStore,
  BlocklistService,
  DriverResolver,
  LeaseSweeper,
  PlaywrightBrowserDriver,
  SessionService,
} from '@browserhive/core/server';
import type { DegradationRelay } from '../adapters/degradation-relay.ts';
import { type SandboxHost, type SandboxWiring } from '../sandbox.ts';
/** Inputs of {@link buildSessions}. */
export interface SessionsInput {
  readonly config: Readonly<ServerConfig>;
  readonly host: HostFacts;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly logger: Logger;
  readonly bus: EventBus<DomainEvents>;
  readonly relay: DegradationRelay;
  /** Where each key came from (the `sandbox=on` refusal quotes how it was set). */
  readonly provenance: Provenance;
  readonly configFilePath: string | undefined;
  /** Test seam for the sandbox probes. */
  readonly sandboxHost?: SandboxHost;
  /** Chromium switches of the internal testing seam (spec 13 §14). */
  readonly testingArgs?: readonly string[];
}
/** Built session-side services. */
export interface SessionsParts {
  readonly driverName: () => 'patchright' | 'playwright';
  /** The browser driver; it also starts template hosts (spec 13 §3.1). */
  readonly driver: PlaywrightBrowserDriver;
  readonly browserInstalled: boolean;
  /** Version of the Chromium build `chromium` sessions launch; `null` when it is not installed. */
  readonly chromiumVersion: string | null;
  readonly blocklist: BlocklistService;
  readonly stopWatcher: (() => void) | null;
  readonly authStates: AuthStateStore;
  readonly sessions: SessionService;
  readonly sweeper: LeaseSweeper;
  readonly sandbox: SandboxWiring;
}
/** `fs.watch` adapter for the blocklist hot reload (D-22). */
export declare const nodeBlocklistWatcher: BlocklistFileWatcher;
/**
 * Checks the Chromium binary for the resolved driver. A missing browser is not a boot failure
 * (D-18): it is reported as a `BROWSER_NOT_INSTALLED` degradation and surfaces as the typed error at
 * the first launch.
 */
export declare function probeBrowser(
  resolver: DriverResolver,
  input: Pick<SessionsInput, 'config' | 'host' | 'relay' | 'logger'>,
): boolean;
/** Builds the session side. `blocklist.load()` failing is fatal (`BLOCKLIST_LOAD_FAILED`). */
export declare function buildSessions(input: SessionsInput): Promise<SessionsParts>;
//# sourceMappingURL=domain-sessions.d.ts.map
