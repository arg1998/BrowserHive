/** @module composition/phases/domain-templates — the template service (spec 13 §2, §5, §6, §11.1): repositories, the pinned-identity geo, the template directories and the host supervisor (the runtime that starts template browsers); under `templates=false` the runtime has no hosts. */

import { hostname, networkInterfaces } from 'node:os';
import { join } from 'node:path';
import type { ServerConfig } from '@browserhive/contracts/config';
import type { SqliteUnitOfWork } from '@browserhive/core/persistence';
import {
  type Clock,
  createProcessTreeReader,
  type DegradationReporter,
  type IdGenerator,
  type Logger,
  serializeError,
} from '@browserhive/core/runtime';
import {
  createTemplateFiles,
  createTemplateGeoResolver,
  type HostFacts,
  HostGeoSeedResolver,
  PassThroughProxyResolver,
  type PlaywrightBrowserDriver,
  type SessionService,
  TemplateHostSupervisor,
  TemplateService,
  UnavailableTemplateRuntime,
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
  /** The composition's interval timer (the supervisor's periodic pass). */
  readonly repeat: (fn: () => void, ms: number) => () => void;
}

/** How often template hosts are checked for idleness, age and memory (spec 13 §3.2). */
export const TEMPLATE_HOST_TICK_MS = 60_000;

/** The template service and the supervisor behind it (`null` under `templates=false`). */
export interface TemplatesParts {
  readonly service: TemplateService;
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
export function machineNames(): MachineNames {
  const addresses = Object.values(networkInterfaces())
    .flat()
    .flatMap((info) => (info === undefined ? [] : [info.address]));
  return { hostname: hostname(), addresses };
}

/**
 * BrowserHive's own origins (spec 13 §3.8): the self-origin guard of a template host blocks them,
 * and every loopback spelling on their ports; the host's marker cookie is set for each. The bound
 * host, the canonical loopback names, the extra `allowedHosts` and the `publicUrl` origin; under a
 * wildcard bind also the machine's host name (and `<name>.local`) and every interface address.
 */
export function selfOriginsOf(
  config: Readonly<ServerConfig>,
  machine: MachineNames = machineNames(),
): string[] {
  const port = config.port;
  const hosts = new Set([config.host, 'localhost', '127.0.0.1', '::1', ...config.allowedHosts]);
  if (['0.0.0.0', '::', ''].includes(config.host)) {
    hosts.add(machine.hostname);
    hosts.add(`${machine.hostname}.local`);
    for (const address of machine.addresses) hosts.add(address);
  }
  const origins = [...hosts]
    .filter((host) => host !== '' && host !== '::')
    .flatMap((host) => {
      const bare = host.replace(/^\[|\]$/g, '');
      const name = bare.includes(':') ? `[${bare}]` : bare;
      return port > 0 ? [`http://${name}:${port}`, `https://${name}:${port}`] : [];
    });
  if (config.publicUrl !== undefined) origins.push(config.publicUrl);
  return origins;
}

/** `<data-dir>/templates` (spec 13 §2.4). */
export function templatesDirOf(dataDir: string): string {
  return join(dataDir, 'templates');
}

/** Builds the template service. */
export function buildTemplates(input: TemplatesInput): TemplatesParts {
  const { config } = input;
  const reader = createProcessTreeReader();
  const supervisor = config.templates
    ? new TemplateHostSupervisor({
        launcher: input.driver,
        sessions: input.sessions,
        templates: input.uow.repos.templates,
        clock: input.clock,
        logger: input.logger,
        degradations: input.degradations,
        spec: {
          dataDir: config.dataDir,
          stealthDriver: config.stealthDriver,
          proxyResolver: new PassThroughProxyResolver(),
          env: input.host.env,
          selfOrigins: () => selfOriginsOf(config),
          testingArgs: [],
        },
        config: {
          idleTimeoutMs: config.templateHostIdleTimeout,
          recycleAfterMs: config.templateRecycleAfter,
          drainTimeoutMs: config.templateDrainTimeout,
          maxPagesPerHost: config.templateMaxPagesPerHost,
          closeTimeoutMs: config.sessionCloseTimeout,
        },
        ...(reader !== null && {
          rssOf: async (pid: number) => (await reader.rssOfTrees([pid])).get(pid) ?? null,
        }),
      })
    : null;
  const service = new TemplateService({
    repos: input.uow.repos,
    uow: input.uow,
    runtime: supervisor ?? new UnavailableTemplateRuntime(),
    geo: createTemplateGeoResolver(new HostGeoSeedResolver(input.host)),
    files: createTemplateFiles(templatesDirOf(config.dataDir)),
    degradations: input.degradations,
    ids: input.ids,
    clock: input.clock,
    logger: input.logger,
    config: {
      enabled: config.templates,
      authMode: config.auth,
      maxPagesPerHost: config.templateMaxPagesPerHost,
      defaults: {
        channel: config.defaultChannel,
        stealth: config.stealth,
        fingerprint: config.fingerprint,
        humanize: config.humanize,
      },
    },
  });
  // Idle stop, age recycle and memory sampling of template hosts (spec 13 §3.2).
  const stopTicks =
    supervisor === null
      ? () => undefined
      : input.repeat(() => {
          supervisor
            .tick()
            .catch((err: unknown) =>
              input.logger.warn('host tick failed', { err: serializeError(err) }),
            );
        }, TEMPLATE_HOST_TICK_MS);
  return { service, supervisor, stopTicks };
}
