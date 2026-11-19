/** @module composition/phases/domain-templates — the template service (spec 13 §2, §5, §6, §11.1): repositories, the pinned-identity geo, the template directories and the host supervisor (the runtime that starts template browsers); under `templates=false` the runtime has no hosts. */

import { hostname } from 'node:os';
import { join } from 'node:path';
import type { ServerConfig } from '@browserhive/contracts/config';
import type { SqliteUnitOfWork } from '@browserhive/core/persistence';
import type { DomainEvents, EventBus } from '@browserhive/core/runtime';
import {
  type Clock,
  createProcessTreeReader,
  type DegradationReporter,
  type IdGenerator,
  type Logger,
  serializeError,
} from '@browserhive/core/runtime';
import {
  applyClipboardPolicy,
  createTemplateFiles,
  createTemplateGeoResolver,
  displayMissing,
  FileTemplateStateStore,
  type HostFacts,
  HostGeoSeedResolver,
  hostTemplatePacks,
  PassThroughProxyResolver,
  type PlaywrightBrowserDriver,
  type ProberSelector,
  reconcileTemplateState,
  resolveTemplateKeys,
  type SessionService,
  type SitePackRegistry,
  TemplateActions,
  TemplateEditService,
  type TemplateHealthParts,
  TemplateHostOperations,
  TemplateHostSupervisor,
  TemplateOperations,
  TemplateRecordingService,
  TemplateService,
  TemplateStateService,
  UnavailableTemplateHostOps,
  UnavailableTemplateRuntime,
  unavailableHealthFacade,
  type VaultService,
  watchClipboardOnStart,
  wireTemplateHealth,
} from '@browserhive/core/server';
import type { SiteStrategies } from '../site-pack-strategies.ts';
import { wireSitePackUsage } from '../site-packs.ts';

export { type MachineNames, machineNames, selfOriginsOf } from '../self-origins.ts';

import { selfOriginsOf } from '../self-origins.ts';

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
  /** The `templates` topic, the checkpoint metric and the health hooks. */
  readonly bus: EventBus<DomainEvents>;
  /** The vault (auto-relogin fills and the binding link); absent or unconfigured under `vault=off`. */
  readonly vault?: VaultService;
  /** The machine sign-in windows open on (`os.hostname()`; test seam). */
  readonly machine?: string;
  /** `templateKey` came from a command-line flag (warned: argv is readable by other users). */
  readonly keyFromFlag?: boolean;
  /** Site packs (T3a): approval on first use, the sites' packs, providers and `human_only`. */
  readonly sitePacks?: SitePackRegistry;
  /** The prober of each site over the supervisor (T3a: the pack prober); default generic. */
  readonly probers?: (supervisor: TemplateHostSupervisor) => ProberSelector;
  /** The host-side pack strategies (T3b: `webrtc-policy`, `keep-alive`, `device-bound-session`). */
  readonly siteStrategies?: SiteStrategies;
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
  /** Health and re-login (T2); `null` under `templates=false`. */
  readonly health: TemplateHealthParts | null;
  /** The T2 routes' service. */
  readonly healthRoutes: TemplateHealthParts['facade'] | ReturnType<typeof unavailableHealthFacade>;
  /** Stops the supervisor's periodic pass and the probe schedule. */
  readonly stopTicks: () => void;
}

/** How often the probe schedule looks for due templates (spec 13 §8.3). */
export const TEMPLATE_HEALTH_TICK_MS = 60_000;
/** How often open sign-in windows are checked for pack sites' sign-in cookies (spec 13 §7.1). */
export const TEMPLATE_RECORDING_TICK_MS = 5_000;

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
  // The sites' strategy notes read this machine's platform (D49 `single-focus`, D50 humanize).
  const packs =
    input.sitePacks === undefined
      ? {}
      : { packs: hostTemplatePacks(input.sitePacks, input.host.platform) };
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
          proxyResolver: new PassThroughProxyResolver(),
          env: input.host.env,
          platform: input.host.platform,
          selfOrigins: () => selfOriginsOf(config),
          testingArgs: input.testingArgs ?? [],
          ...(input.siteStrategies !== undefined && { hostFlags: input.siteStrategies.hostFlags }),
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
        sitePacks: () => (input.sitePacks?.enabled === true ? input.sitePacks : null),
        ...(reader !== null && {
          // Proportional memory where the platform reports it (Linux), so the memory limit is not
          // reached by memory the browser's processes share (workload test B2).
          rssOf: async (pid: number) =>
            (await (reader.memoryOfTrees ?? reader.rssOfTrees).call(reader, [pid])).get(pid) ??
            null,
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
    ...packs,
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
    ...packs,
  });
  // Pack sites read signed in from their sign-in cookies while a sign-in window is open (§7.1).
  const stopRecordingTicks = input.repeat(() => void recording.tick(), TEMPLATE_RECORDING_TICK_MS);
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
    ...packs,
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
        // A new template's Agent windows (D-77): the `headedWindows` setting.
        agentWindows: config.headedWindows,
      },
    },
  });
  changed = (id) => service.publishChanged(id);
  if (input.sitePacks !== undefined) {
    wireSitePackUsage(input.sitePacks, input.bus, input.logger, changed);
  }
  const common = { ids: input.ids, clock: input.clock, logger: input.logger, changed };
  const clipboardWrites = async (id: string, deny: boolean) => {
    const host = supervisor?.runningHost(id) ?? null;
    if (host !== null) await applyClipboardPolicy(host.context, deny, input.logger);
  };
  // A clipboard change that landed while the browser started is applied once it runs (D18).
  const offClipboard =
    supervisor === null
      ? () => undefined
      : watchClipboardOnStart({
          templates: input.uow.repos.templates,
          runtime,
          ops,
          clipboardWrites,
          bus: input.bus,
          logger: input.logger,
        });
  const edit = new TemplateEditService({
    repos: input.uow.repos,
    uow: input.uow,
    runtime,
    ops,
    sessions: input.sessions,
    bus: input.bus,
    ...packs,
    ...common,
    clipboardWrites,
  });
  const actions = new TemplateActions({
    repos: input.uow.repos,
    runtime,
    ops,
    state,
    files,
    ...common,
  });
  // Every site is probed after a restore or seed (spec 13 §3.12, §7.4; deferred D22).
  let restored: (templateId: string) => void = () => undefined;
  const operations = new TemplateOperations({
    repos: input.uow.repos,
    ops,
    state,
    bus: input.bus,
    afterApply: (templateId) => restored(templateId),
    ...common,
  });
  const health =
    supervisor === null || !(ops instanceof TemplateHostOperations)
      ? null
      : wireTemplateHealth({
          repos: input.uow.repos,
          supervisor,
          ops,
          sessions: input.sessions,
          service,
          state,
          ...(input.vault !== undefined && { vault: input.vault }),
          bus: input.bus,
          ids: input.ids,
          clock: input.clock,
          logger: input.logger,
          machine: input.machine ?? hostname(),
          displayAvailable: () => !displayMissing(input.host.platform, input.host.env),
          changed,
          ...packs,
          ...(input.probers !== undefined && { probers: input.probers(supervisor) }),
        });
  if (health !== null) {
    restored = (id) => health.scheduler.restored(id);
    recording.attachHealth(health.health);
  }
  if (supervisor !== null && ops instanceof TemplateHostOperations) {
    input.siteStrategies?.attach({ supervisor, ops, health, changed, repeat: input.repeat });
  }
  // Idle stop, age recycle, memory and checkpoints of template hosts (spec 13 §3.2, §3.9).
  const stopHostTicks =
    supervisor === null
      ? () => undefined
      : input.repeat(() => {
          supervisor
            .tick()
            .catch((err: unknown) =>
              input.logger.warn('host tick failed', { err: serializeError(err) }),
            );
        }, TEMPLATE_HOST_TICK_MS);
  // The probe schedule (spec 13 §8.3): never throws.
  const stopHealthTicks =
    health === null
      ? () => undefined
      : input.repeat(() => void health.scheduler.tick(), TEMPLATE_HEALTH_TICK_MS);
  const stopTicks = () => {
    stopHostTicks();
    stopHealthTicks();
    stopRecordingTicks();
    health?.stop();
    offClipboard();
  };
  return {
    service,
    recording,
    supervisor,
    edit,
    actions,
    state,
    operations,
    health,
    healthRoutes: health?.facade ?? unavailableHealthFacade(),
    stopTicks,
  };
}
