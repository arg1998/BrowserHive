/** @module composition/phases/build-domain — phase 4: clock/ids/bus, degradations, sessions, operators, vault, auth (seed flow), notifications, schedulers, startup reconcile, tools. */

import {
  CHANNEL_RENDERERS,
  channelFactories,
  createDiscordSetup,
  createTelegramSetup,
  createUrlProbe,
} from '@browserhive/core/notifications';
import type { DomainEvents } from '@browserhive/core/runtime';
import {
  createNanoidIdGenerator,
  DegradationService,
  isInsecurePublicUrl,
  serializeError,
} from '@browserhive/core/runtime';
import {
  createPlaywrightPageActions,
  InProcessEventBus,
  reloginActionExecutor,
  TemplateRefusals,
} from '@browserhive/core/server';
import { notificationCounters } from '../adapters/metrics.ts';
import { asyncTick, createTimers } from '../adapters/timers.ts';
import { createAuthStack } from '../auth-stack.ts';
import { type BootContext, part } from '../context.ts';
import { hostFactsOf } from '../host.ts';
import { createNotificationSnapshots } from '../notification-snapshots.ts';
import { buildSiteActions } from '../site-pack-actions.ts';
import { attachSitePackEnforcement, buildSitePackLayer } from '../site-pack-layer.ts';
import type { PhaseHandle } from '../unwind.ts';
import { seedCredentials, warnReservedSubjects } from './domain-credentials.ts';
import { notificationParts } from './domain-notifications.ts';
import { buildOperators } from './domain-operators.ts';
import { buildOps, reconcile } from './domain-ops.ts';
import { buildSessions } from './domain-sessions.ts';
import { buildTemplates, templatesDirOf } from './domain-templates.ts';
import { buildTools } from './domain-tools.ts';

export { warnReservedSubjects } from './domain-credentials.ts';
export { IMAGE_KEEP_MS, IMAGE_PRUNE_INTERVAL_MS } from './domain-notifications.ts';

/** How often expired auth sessions, grants and rate buckets are swept. */
export const AUTH_SWEEP_INTERVAL_MS = 5 * 60 * 1000;

/** Phase `build-domain`. Stop drains sessions (the 15 s budget) and settles operator requests. */
export async function buildDomainPhase(ctx: BootContext): Promise<PhaseHandle> {
  ctx.health.enter('build-domain');
  const undo: (() => void | Promise<void>)[] = [];
  try {
    return await buildDomain(ctx, undo);
  } catch (err) {
    // Nothing after this phase exists yet: release what this phase already started, newest first.
    for (const step of undo.reverse()) await step();
    throw err;
  }
}

async function buildDomain(
  ctx: BootContext,
  undo: (() => void | Promise<void>)[],
): Promise<PhaseHandle> {
  const { config, clock, transport, relay } = ctx;
  const { logger, secrets, redactor, telemetry } = part(ctx.observability, 'observability');
  const storage = part(ctx.storage, 'storage');
  const repos = storage.uow.repos;
  const ids = createNanoidIdGenerator({ clock });
  const bus = new InProcessEventBus<DomainEvents>({ clock, logger });

  const degradations = new DegradationService({
    repo: repos.systemEvents,
    bus,
    clock,
    ids,
    logger,
  });
  await degradations.load();
  relay.attach(degradations);
  undo.push(async () => {
    relay.detach();
    await degradations.idle();
  });

  const sessionParts = await buildSessions({
    config,
    ...(ctx.input.testingArgs !== undefined && { testingArgs: ctx.input.testingArgs }),
    host: hostFactsOf(ctx.input.host),
    clock,
    ids,
    logger,
    bus,
    relay,
    provenance: ctx.input.resolved.provenance,
    configFilePath: ctx.input.resolved.configFilePath,
    ...(ctx.input.sandboxHost !== undefined && { sandboxHost: ctx.input.sandboxHost }),
  });
  undo.push(() => sessionParts.stopWatcher?.());
  ctx.health.check('browser', sessionParts.browserInstalled ? 'ok' : 'degraded');
  const { sessions } = sessionParts;
  const operators = buildOperators({
    config,
    transport,
    host: ctx.input.host,
    repos,
    sessions,
    bus,
    clock,
    ids,
    logger,
    secrets,
  });
  const pageActions = createPlaywrightPageActions({ clock });

  // Session close settles its operator requests and releases per-session vault/humanize state.
  const offClosed = bus.subscribe('session.closed', ({ payload }) => {
    operators.vaultRedaction.close(payload.session_id);
    pageActions.forgetSession(payload.session_id);
    void operators.broker
      .settleForSession(payload.session_id, payload.reason)
      .catch((err: unknown) => logger.warn('settle requests failed', { err: serializeError(err) }));
  });
  undo.push(offClosed);

  const auth = createAuthStack({
    repos,
    dataDir: config.dataDir,
    clock,
    ids,
    logger,
    mode: config.auth,
    authTokens: config.authTokens,
    allowInsecureBind: config.allowInsecureBind,
    bus,
    registerSecret: (literal) => secrets.add(literal),
  });
  const seeds = await seedCredentials(ctx, auth.service);
  await warnReservedSubjects(logger, auth.service, config.authTokens);
  const timers = createTimers((err) =>
    logger.warn('timer callback failed', { err: serializeError(err) }),
  );

  const {
    images,
    instanceId,
    cursors,
    telegramUpdates,
    discordGateway,
    actionExecutors,
    stopImagePrune,
  } = notificationParts({ config, repos, clock, ids, logger, operators, timers, undo });
  const ops = buildOps({
    // `browserhive.notifications.*` (spec 10 §7): no-ops unless telemetry is on.
    ...notificationCounters(telemetry.instruments),
    config,
    repos,
    queue: storage.queue,
    handle: storage.handle,
    analytics: storage.analytics,
    maintenance: storage.maintenance,
    bus,
    clock,
    ids,
    logger,
    redactor,
    degradations,
    uow: storage.uow,
    env: ctx.input.env,
    registerSecret: (literal) => secrets.add(literal),
    dashboardUrl: () => ctx.listeners?.url ?? `http://${config.host}:${config.port}`,
    channelFactories: channelFactories({
      images,
      telegramUpdates,
      discordGateway,
      cursors,
      logger,
    }),
    renderers: CHANNEL_RENDERERS,
    telegram: createTelegramSetup({ updates: telegramUpdates }),
    discord: createDiscordSetup({ gateway: discordGateway }),
    actionExecutors,
    probe: createUrlProbe(),
    instanceId,
    capacity: () => {
      const status = sessions.serverStatus();
      return { live: status.count, max: status.limit ?? 0 };
    },
    snapshots: createNotificationSnapshots({
      sessions,
      screenshots: repos.screenshots,
      images,
      secretWindowOpen: (sessionId) => secrets.isWindowOpen(sessionId),
      now: () => clock.now(),
      logger,
    }),
  });
  // Startup channels (--notificationChannel, D-39): projected into the table, read-only. A name a
  // dashboard channel already uses stops startup with CONFIG_INVALID (exit 64).
  for (const warning of ctx.input.startupChannelWarnings ?? []) {
    logger.warn('startup channel warning', { detail: warning });
  }
  await ops.channels.load(ctx.input.startupChannels ?? []);
  if (isInsecurePublicUrl(config.publicUrl)) {
    logger.warn('publicUrl is plain http', { public_url: config.publicUrl });
  }
  const templatesDir = templatesDirOf(config.dataDir);
  await reconcile({ repos, clock, logger, degradations, broker: operators.broker, templatesDir });
  // Requests settled while nothing listened (the last shutdown, the orphan recovery above) revise
  // their notifications now; the producers subscribe later, in wire-observers.
  await ops.notifications
    .reconcileRequests(repos.operatorRequests)
    .catch((err: unknown) => logger.warn('catch-up failed', { err: serializeError(err) }));

  const layer = await buildSitePackLayer({
    config,
    release: ctx.input.appVersion,
    trustRoot: ctx.input.sitePacksTrustRoot,
    uow: storage.uow,
    repos,
    clock,
    ids,
    logger,
    bus,
    degradations,
    sessions,
    transport,
    undo,
  });
  const sitePacks = layer.registry;
  const sitePackPages = layer.pages;
  // Refused agents (D60): written through the recorder's queue, never awaited by an agent's call.
  const templateRefusals = new TemplateRefusals({
    queue: storage.queue,
    repos: storage.uow.repos,
    logger,
  });
  const tpl = await buildTemplates({
    config,
    refusals: templateRefusals,
    bus,
    sitePacks,
    keyFromFlag: ctx.input.resolved.provenance['templateKey']?.source === 'cli',
    ...(ctx.input.testingArgs !== undefined && { testingArgs: ctx.input.testingArgs }),
    host: hostFactsOf(ctx.input.host),
    uow: storage.uow,
    clock,
    ids,
    logger,
    degradations,
    sessions,
    driver: sessionParts.driver,
    repeat: timers.every,
    vault: operators.vault,
    ...(layer.probers !== undefined && { probers: layer.probers }),
    ...(layer.strategies !== undefined && { siteStrategies: layer.strategies }),
  });
  const templates = tpl.service;
  // The notification button of a sign-out only queues the re-login (spec 13 §8.4, §8.6).
  const relogin = tpl.health?.relogin;
  if (relogin !== undefined) {
    actionExecutors.set('template.relogin', reloginActionExecutor(relogin));
  }

  // Site-pack enforcement: the request guard on every template host, security intercepts (T3a).
  const enforcement = attachSitePackEnforcement(layer, {
    config,
    transport,
    driver: sessionParts.driver,
    broker: operators.broker,
    sessions,
    uow: storage.uow,
    health: tpl.health,
    bus,
    ids,
    clock,
    logger,
    undo,
  });
  const tools = buildTools({
    config,
    transport,
    version: ctx.input.appVersion,
    startedAt: ctx.startedAt,
    sessions,
    attention: operators.attention,
    vault: operators.vault,
    vaultBackend: operators.vaultBackend,
    vaultRedaction: operators.vaultRedaction,
    authStates: sessionParts.authStates,
    blocklist: sessionParts.blocklist,
    templates,
    ...(tpl.supervisor !== null && { templatePause: tpl.supervisor.pause }),
    ...(enforcement !== null && { siteHolds: enforcement.intercepts }),
    pageActions,
    ...(enforcement !== null && { siteGuards: sitePackPages.gate }),
    ...(enforcement !== null && {
      siteActions: buildSiteActions({
        repos,
        sessions,
        lookup: sitePacks,
        navigations: sitePackPages.navigations,
        state: layer.strategies?.state ?? null,
        bus,
        clock,
        logger,
        undo,
      }),
    }),
    redactor,
    bus,
    clock,
    ids,
    logger,
  });

  const stopAuthSweep = timers.every(
    asyncTick(
      () => auth.service.sweep(),
      (err) => logger.warn('auth sweep failed', { err: serializeError(err) }),
    ),
    AUTH_SWEEP_INTERVAL_MS,
  );

  ctx.domain = {
    ids,
    bus,
    degradations,
    driverName: sessionParts.driverName,
    browserInstalled: sessionParts.browserInstalled,
    chromiumVersion: sessionParts.chromiumVersion,
    sandbox: sessionParts.sandbox,
    blocklist: sessionParts.blocklist,
    authStates: sessionParts.authStates,
    sessions,
    sweeper: sessionParts.sweeper,
    broker: operators.broker,
    attention: operators.attention,
    vault: operators.vault,
    vaultRedaction: operators.vaultRedaction,
    vaultBackend: operators.vaultBackend,
    auth: auth.service,
    adminAuthenticator: auth.admin,
    mcpAuthenticator: auth.mcp,
    notifications: ops.notifications,
    channels: ops.channels,
    notificationOutbox: ops.notificationOutbox,
    channelService: ops.channelService,
    actionListeners: ops.actionListeners,
    reports: ops.reports,
    reportSettings: ops.reportSettings,
    reportService: ops.reportService,
    publicUrl: ops.publicUrl,
    templates,
    sitePacks,
    templateRecording: tpl.recording,
    templateRefusals,
    templateParts: tpl,
    sitePackPages,
    strategyState: layer.strategies?.state ?? null,
    instanceId,
    preferences: ops.preferences,
    recorder: ops.recorder,
    retention: ops.retention,
    outbox: ops.outbox,
    backups: ops.backups,
    pageActions,
    runtime: tools.runtime,
    dispatcher: tools.dispatcher,
    seeds,
  };

  return {
    async stop(deadlineMs) {
      stopAuthSweep();
      stopImagePrune();
      ops.channelService.stop();
      telegramUpdates.stop();
      discordGateway.stop();
      sessionParts.sweeper.stop();
      sessionParts.stopWatcher?.();
      tpl.stopTicks();
      const began = clock.now();
      await sessions.closeAll('shutdown', Math.max(1_000, deadlineMs - 500));
      // Template hosts close after their sessions, within what is left (spec 13 §3.2).
      await tpl.supervisor?.stopAll(Math.max(1_000, deadlineMs - 500 - (clock.now() - began)));
      await layer.strategies?.state?.stop(); // budgets and spacings outlive the restart (D53)
      templateRefusals.stop(); // held refusals go to the write queue (review #93 L1)
      await operators.broker.shutdown();
      operators.vaultRedaction.closeAll();
      offClosed();
      // The recorder outlives the observers so the shutdown closes above are still recorded.
      ops.recorder.stop();
      await ops.notifications.idle();
      await degradations.idle();
      relay.detach();
    },
  };
}
