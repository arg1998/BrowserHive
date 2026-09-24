/** @module composition/phases/build-domain — phase 4: clock/ids/bus, degradations, sessions, operators, vault, auth (seed flow), notifications, schedulers, startup reconcile, tools. */

import type { DomainEvents } from '@browserhive/core/runtime';
import {
  createNanoidIdGenerator,
  DegradationService,
  serializeError,
} from '@browserhive/core/runtime';
import { createPlaywrightPageActions, InProcessEventBus } from '@browserhive/core/server';
import { asyncTick, createTimers } from '../adapters/timers.ts';
import { createAuthStack } from '../auth-stack.ts';
import { type BootContext, part, type SeedNotice } from '../context.ts';
import { hostFactsOf } from '../host.ts';
import type { PhaseHandle } from '../unwind.ts';
import { buildOperators } from './domain-operators.ts';
import { buildOps, reconcile } from './domain-ops.ts';
import { buildSessions } from './domain-sessions.ts';
import { buildTools } from './domain-tools.ts';

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
  const { logger, secrets, redactor } = part(ctx.observability, 'observability');
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

  const ops = buildOps({
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
  });
  await reconcile({ repos, clock, logger, degradations, broker: operators.broker });

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
    pageActions,
    redactor,
    bus,
    clock,
    ids,
    logger,
  });

  const timers = createTimers((err) =>
    logger.warn('timer callback failed', { err: serializeError(err) }),
  );
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
      sessionParts.sweeper.stop();
      sessionParts.stopWatcher?.();
      await sessions.closeAll('shutdown', Math.max(1_000, deadlineMs - 500));
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

/**
 * Seed flow (D-09): the first http start with `admin=true` creates the operator with a one-time
 * password; `auth=token` without stored or configured tokens mints `agent-1`'s token. Secrets are
 * returned for the banner only (never logged). Nothing is seeded under stdio.
 */
async function seedCredentials(
  ctx: BootContext,
  auth: {
    seedAdmin: () => Promise<SeedAdminResult>;
    seedAgentToken: () => Promise<SeedTokenResult>;
  },
): Promise<SeedNotice> {
  if (ctx.transport !== 'http') return { adminPassword: null, agentToken: null };
  let adminPassword: SeedNotice['adminPassword'] = null;
  if (ctx.config.admin) {
    const seed = await auth.seedAdmin();
    if (seed.seeded) {
      adminPassword = { password: seed.password.reveal(), path: seed.credentialsPath };
    }
  }
  let agentToken: SeedNotice['agentToken'] = null;
  if (ctx.config.auth === 'token') {
    const seed = await auth.seedAgentToken();
    if (seed.seeded) agentToken = { principalId: seed.principalId, token: seed.token.reveal() };
  }
  return { adminPassword, agentToken };
}

type SeedAdminResult =
  | { readonly seeded: false }
  | {
      readonly seeded: true;
      readonly password: { reveal(): string };
      readonly credentialsPath: string;
    };

type SeedTokenResult =
  | { readonly seeded: false }
  | { readonly seeded: true; readonly principalId: string; readonly token: { reveal(): string } };
