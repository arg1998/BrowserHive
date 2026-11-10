/** @module composition/phases/domain-templates — the template service (spec 13 §2, §5, §6, §11.1): repositories, the pinned-identity geo, the template directories and the host supervisor (the runtime that starts template browsers); under `templates=false` the runtime has no hosts. */
import type { ServerConfig } from '@browserhive/contracts/config';
import type { SqliteUnitOfWork } from '@browserhive/core/persistence';
import {
  type Clock,
  type DegradationReporter,
  type IdGenerator,
  type Logger,
} from '@browserhive/core/runtime';
import {
  type HostFacts,
  type PlaywrightBrowserDriver,
  type SessionService,
  TemplateHostSupervisor,
  TemplateRecordingService,
  TemplateService,
} from '@browserhive/core/server';
/** Inputs of {@link buildTemplates}. */
export interface TemplatesInput {
  readonly config: Readonly<ServerConfig>;
  readonly host: HostFacts;
  readonly uow: SqliteUnitOfWork;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly logger: Logger;
  /** Unreadable rows `list_templates` skips are recorded here. */
  readonly degradations: DegradationReporter;
  readonly sessions: SessionService;
  /** Starts template hosts. */
  readonly driver: PlaywrightBrowserDriver;
  /** Chromium switches of the internal testing seam (spec 13 §14). */
  readonly testingArgs?: readonly string[];
  /** The composition's interval timer (the supervisor's periodic pass). */
  readonly repeat: (fn: () => void, ms: number) => () => void;
}
/** How often template hosts are checked for idleness, age and memory (spec 13 §3.2). */
export declare const TEMPLATE_HOST_TICK_MS = 60000;
/** The template service and the supervisor behind it (`null` under `templates=false`). */
export interface TemplatesParts {
  readonly service: TemplateService;
  /** Recording and the T1a host routes (spec 13 §7.1, §11.1). */
  readonly recording: TemplateRecordingService;
  readonly supervisor: TemplateHostSupervisor | null;
  /** Stops the supervisor's periodic pass. */
  readonly stopTicks: () => void;
}
/** The machine's names and addresses, for a wildcard bind (test seam). */
export interface MachineNames {
  readonly hostname: string;
  readonly addresses: readonly string[];
}
/** This machine's host name and interface addresses. */
export declare function machineNames(): MachineNames;
/**
 * BrowserHive's own origins (spec 13 §3.8): the self-origin guard of a template host blocks them,
 * and every loopback spelling on their ports; the host's marker cookie is set for each. The bound
 * host, the canonical loopback names, the extra `allowedHosts` and the `publicUrl` origin; under a
 * wildcard bind also the machine's host name (and `<name>.local`) and every interface address.
 */
export declare function selfOriginsOf(
  config: Readonly<ServerConfig>,
  machine?: MachineNames,
): string[];
/** `<data-dir>/templates` (spec 13 §2.4). */
export declare function templatesDirOf(dataDir: string): string;
/** Builds the template service. */
export declare function buildTemplates(input: TemplatesInput): TemplatesParts;
//# sourceMappingURL=domain-templates.d.ts.map
