/** @module composition/phases/domain-templates — the template service (spec 13 §2, §5, §6, §11.1): repositories, the pinned-identity geo, the template directories and the host supervisor (the runtime that starts template browsers); under `templates=false` the runtime has no hosts. */

import { hostname, networkInterfaces } from 'node:os';
import { join } from 'node:path';
import type { ServerConfig } from '@browserhive/contracts/config';
import type { SqliteUnitOfWork } from '@browserhive/core/persistence';
import type { DomainEvents, EventPublisher } from '@browserhive/core/runtime';
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
  FileTemplateStateStore,
  type HostFacts,
  HostGeoSeedResolver,
  PassThroughProxyResolver,
  type PlaywrightBrowserDriver,
  reconcileTemplateState,
  resolveTemplateKeys,
  type SessionService,
  TemplateActions,
  TemplateEditService,
  TemplateHostOperations,
  TemplateHostSupervisor,
  TemplateOperations,
  TemplateRecordingService,
  TemplateService,
  TemplateStateService,
  UnavailableTemplateHostOps,
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
  /** Chromium switches of the internal testing seam (spec 13 §14). */
  readonly testingArgs?: readonly string[];
  /** The composition's interval timer (the supervisor's periodic pass). */
  readonly repeat: (fn: () => void, ms: number) => () => void;
  /** The `templates` topic and the checkpoint metric. */
  readonly bus: EventPublisher<DomainEvents>;
  /** `templateKey` came from a command-line flag (warned: argv is readable by other users). */
  readonly keyFromFlag?: boolean;
}

/** How often template hosts are checked for idleness, age and memory (spec 13 §3.2). */
export const TEMPLATE_HOST_TICK_MS = 60_000;

/** The template service and the supervisor behind it (`null` under `templates=false`). */
export interface TemplatesParts {
  readonly service: TemplateService;
  /** Recording and the T1a host routes (spec 13 §7.1, §11.1). */
  readonly recording: TemplateRecordingService;
  readonly supervisor: TemplateHostSupervisor | null;
  /** Edits, actions, versions and operations (T1b). */
  readonly edit: TemplateEditService;
  readonly actions: TemplateActions;
  readonly state: TemplateStateService;
  readonly operations: TemplateOperations;
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
  machineOf: () => MachineNames = machineNames,
): string[] {
  const port = config.port;
  const hosts = new Set([config.host, 'localhost', '127.0.0.1', '::1', ...config.allowedHosts]);
  if (['0.0.0.0', '::', ''].includes(config.host)) {
    // Read only for a wildcard bind: the interface list can be slow to read (Windows).
    const machine = machineOf();
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

/**
 * The template state store with the keys resolved once (spec 13 §2.4), after the boot pass over
 * the files. Under `templates=false` no key is resolved or created. A key file that cannot be
 * read or created never stops the server: it is the `TEMPLATE_KEY_MISSING` degradation, with its
 * cause, and checkpoints are skipped (review #79 M-3).
 */
export async function templateStateStore(
  input: TemplatesInput,
  templatesDir: string,
): Promise<FileTemplateStateStore> {
  const { config } = input;
  const none = new FileTemplateStateStore({
    templatesDir,
    keys: { current: null, previous: null },
  });
  if (!config.templates) return none;
  const keys = await resolveTemplateKeys({
    dataDir: config.dataDir,
    configured: config.templateKey,
    previous: config.templateKeyPrevious,
    filesExist: async () => (await none.templatesWithFiles()).length > 0,
  });
  if (keys.problem !== null) {
    input.logger.error('template key unusable', { detail: keys.problem });
    input.degradations.report({
      code: 'TEMPLATE_KEY_MISSING',
      severity: 'error',
      message: `no template key: ${keys.problem}`,
      details: { template_ids: [...(await none.templatesWithFiles())], reason: keys.problem },
    });
  }
  if (input.keyFromFlag === true) {
    input.logger.warn('templateKey given as flag', {
      detail: 'process arguments are readable by other users; use BROWSERHIVE_TEMPLATE_KEY',
    });
  }
  const store = new FileTemplateStateStore({
    templatesDir,
    keys: { current: keys.current, previous: keys.previous },
  });
  await reconcileTemplateState({
    store,
    repos: input.uow.repos,
    degradations: input.degradations,
    logger: input.logger,
  });
  return store;
}

/** Builds the template service. */
export async function buildTemplates(input: TemplatesInput): Promise<TemplatesParts> {
  const { config } = input;
  const templatesDir = templatesDirOf(config.dataDir);
  const store = await templateStateStore(input, templatesDir);
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
          testingArgs: input.testingArgs ?? [],
        },
        config: {
          idleTimeoutMs: config.templateHostIdleTimeout,
          recycleAfterMs: config.templateRecycleAfter,
          drainTimeoutMs: config.templateDrainTimeout,
          maxPagesPerHost: config.templateMaxPagesPerHost,
          closeTimeoutMs: config.sessionCloseTimeout,
          recycleRssBytes: config.templateRecycleRss,
        },
        bus: input.bus,
        onTemplateChanged: (id) => changed(id),
        ...(reader !== null && {
          rssOf: async (pid: number) => (await reader.rssOfTrees([pid])).get(pid) ?? null,
        }),
      })
    : null;
  const runtime = supervisor ?? new UnavailableTemplateRuntime();
  const state = new TemplateStateService({
    repos: input.uow.repos,
    store,
    hostOf: (id) => supervisor?.runningHost(id) ?? null,
    clock: input.clock,
    logger: input.logger,
    degradations: input.degradations,
    bus: input.bus,
    config: {
      checkpointIntervalMs: config.templateCheckpointInterval,
      versionsKeep: config.templateVersionsKeep,
    },
  });
  supervisor?.attachCheckpoints(state);
  let changed: (templateId: string) => void = () => undefined;
  const ops =
    supervisor === null
      ? new UnavailableTemplateHostOps()
      : new TemplateHostOperations({
          supervisor,
          sessions: input.sessions,
          launcher: input.driver,
          dataDir: config.dataDir,
          logger: input.logger,
          clock: input.clock,
          drainTimeoutMs: config.templateDrainTimeout,
        });
  const recording = new TemplateRecordingService({
    repos: input.uow.repos,
    uow: input.uow,
    runtime,
    ops,
    ids: input.ids,
    clock: input.clock,
    logger: input.logger,
    state,
    changed: (id) => changed(id),
  });
  const files = createTemplateFiles(templatesDir);
  const service = new TemplateService({
    repos: input.uow.repos,
    uow: input.uow,
    runtime,
    ops,
    geo: createTemplateGeoResolver(new HostGeoSeedResolver(input.host)),
    files,
    bus: input.bus,
    versions: input.uow.repos.templateVersions,
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
  changed = (id) => service.publishChanged(id);
  const common = { ids: input.ids, clock: input.clock, logger: input.logger, changed };
  const edit = new TemplateEditService({
    repos: input.uow.repos,
    uow: input.uow,
    runtime,
    ops,
    sessions: input.sessions,
    bus: input.bus,
    ...common,
  });
  const actions = new TemplateActions({
    repos: input.uow.repos,
    runtime,
    ops,
    state,
    files,
    ...common,
  });
  const operations = new TemplateOperations({
    repos: input.uow.repos,
    ops,
    state,
    bus: input.bus,
    ...common,
  });
  // Idle stop, age recycle, memory and checkpoints of template hosts (spec 13 §3.2, §3.9).
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
  return { service, recording, supervisor, edit, actions, state, operations, stopTicks };
}
