/** @module app/sessions/create-phases — the phase runners of the D-21 creation pipeline (validate … register) and their compensators. */

import { requestedProxy } from '../../domain/policies/proxy-request.ts';
import { assertAdmitted } from '../../domain/session/admission.ts';
import {
  type CreateSessionRequest,
  validateCreateRequest,
} from '../../domain/session/create-request.ts';
import { Session } from '../../domain/session/session.ts';
import { warningFromLaunch } from '../../domain/session/warnings.ts';
import { raceSignal } from '../../kernel/deadline.ts';
import { AppError } from '../../kernel/errors/app-error.ts';
import { serializeError } from '../../kernel/errors/serialize-error.ts';
import type {
  LaunchIdentity,
  LaunchSpec,
  ProxySpec,
  SessionHandle,
} from '../../ports/browser-driver.ts';
import type { Logger } from '../../ports/logger.ts';
import type { PipelineDeps, PipelineHooks } from './pipeline-deps.ts';
import { prepareSessionDirs, removeSessionDir, type SessionDirs } from './profile-dir.ts';

/** Warning codes the driver emits that later phases adopt (so each phase reports its own findings). */
const TRACING_CODES: ReadonlySet<string> = new Set(['TRACE_START_FAILED']);
const IDENTITY_CODES: ReadonlySet<string> = new Set(['STEALTH_INIT_FAILED']);

/** Mutable state threaded through the phases of one run. */
export interface PipelineContext {
  request?: CreateSessionRequest;
  session?: Session;
  dirs?: SessionDirs;
  storageStatePath?: string;
  restoredSeed: string | null;
  proxy: ProxySpec | null;
  identity?: LaunchIdentity;
  handle?: SessionHandle;
}

/** Registers a compensator that never throws (failures are logged, the unwind continues). */
export function compensate(
  stack: AsyncDisposableStack,
  log: Logger,
  name: string,
  fn: () => Promise<void>,
): void {
  stack.defer(async () => {
    try {
      await fn();
    } catch (err) {
      log.warn('compensator failed', { step: name, err: serializeError(err) });
    }
  });
}

/** One phase: mutates the context, registers its compensator on `stack` before returning. */
export type PhaseRunner = (ctx: PipelineContext) => Promise<void>;

/** Every phase name the runners cover. */
export type PhaseName =
  | 'validate'
  | 'admit'
  | 'reserve'
  | 'prepareProfile'
  | 'resolveIdentity'
  | 'launch'
  | 'installPolicies'
  | 'startTracing'
  | 'applyIdentity'
  | 'register';

/** Builds the runners for one pipeline run. */
export function buildPhases(
  deps: PipelineDeps,
  hooks: PipelineHooks,
  log: Logger,
  stack: AsyncDisposableStack,
  signal: AbortSignal,
  deadlineMs: number,
): Record<PhaseName, PhaseRunner> {
  const need = <T>(value: T | undefined, what: string): T => {
    if (value === undefined) throw new AppError('INTERNAL_ERROR', { ref: `pipeline-${what}` });
    return value;
  };
  return {
    validate: async (ctx) => {
      ctx.request = validateCreateRequest(deps.input, deps.defaults, deps.principal);
    },
    admit: async (ctx) => {
      const request = need(ctx.request, 'request');
      assertAdmitted(deps.admission, {
        occupied: deps.registry.size,
        slug: request.slug,
        principal: request.owner,
      });
    },
    reserve: async (ctx) => {
      const request = need(ctx.request, 'request');
      // Capacity is re-checked under the lock: two creates may both pass `admit` on the same snapshot.
      const session = await deps.registry.withLock(() => {
        assertAdmitted(deps.admission, {
          occupied: deps.registry.size,
          slug: request.slug,
          principal: request.owner,
        });
        const created = new Session({
          id: deps.ids.sessionId(request.slug),
          request,
          createdAt: deps.clock.now(),
          leaseWindowMs: deps.leaseWindowMs,
          tabId: () => deps.ids.tabId(),
        });
        deps.registry.reserve(created);
        return created;
      });
      ctx.session = session;
      compensate(stack, log, 'reserve', async () => {
        deps.registry.release(session.id);
      });
      hooks.opened(session);
    },
    prepareProfile: async (ctx) => {
      const request = need(ctx.request, 'request');
      const session = need(ctx.session, 'session');
      const dirs = deps.layout.forSession(session.id);
      const persistent = request.persistenceMode === 'persistent';
      await prepareSessionDirs(deps.fs, dirs, { persistent, trace: deps.trace });
      ctx.dirs = dirs;
      compensate(stack, log, 'prepareProfile', () => removeSessionDir(deps.fs, dirs));
      if (request.restoreProfile !== null) {
        const locator = authStates(deps, request.restoreProfile, 'profile');
        await locator.restoreProfile(request.restoreProfile, dirs.userdata, deps.principal);
        ctx.restoredSeed = await locator.loadIdentitySeed(request.restoreProfile).catch(() => null);
        session.setIdentitySeed(ctx.restoredSeed);
      }
      if (request.storageStateName !== null) {
        const locator = authStates(deps, request.storageStateName, 'storage');
        ctx.storageStatePath = await locator.storageStatePath(
          request.storageStateName,
          deps.principal,
        );
      }
    },
    resolveIdentity: async (ctx) => {
      const request = need(ctx.request, 'request');
      const session = need(ctx.session, 'session');
      const requested = requestedProxy(request.launchOptions, request.contextOptions);
      ctx.proxy = await deps.proxyResolver.resolve({ sessionId: session.id, requested });
      session.setProxyLabel(ctx.proxy?.label ?? null);
      hooks.proxyAssigned(session, ctx.proxy);
      if (!request.fingerprint) return;
      const resolver = deps.identityResolver;
      if (resolver === undefined) {
        throw new AppError(
          'INTERNAL_ERROR',
          { ref: 'identity-resolver' },
          { message: 'fingerprint requested but no IdentityResolver is wired' },
        );
      }
      const resolved = await resolver.resolve({
        sessionId: session.id,
        headless: request.headless,
        ...(request.launchOptions !== undefined && { launchOptions: request.launchOptions }),
        ...(request.contextOptions !== undefined && { contextOptions: request.contextOptions }),
        proxy: ctx.proxy,
        restoredSeed: ctx.restoredSeed,
      });
      ctx.identity = resolved.identity;
      for (const warning of resolved.warnings)
        hooks.warn(session, warningFromLaunch(session.id, warning));
    },
    launch: async (ctx) => {
      const request = need(ctx.request, 'request');
      const session = need(ctx.session, 'session');
      const dirs = need(ctx.dirs, 'dirs');
      const spec: LaunchSpec = {
        sessionId: session.id,
        channel: request.channel,
        incognito: request.incognito,
        headless: request.headless,
        persistenceMode: request.persistenceMode,
        ...(request.persistenceMode === 'persistent' && { userDataDir: dirs.userdata }),
        ...(ctx.storageStatePath !== undefined && { storageStatePath: ctx.storageStatePath }),
        ...(request.launchOptions !== undefined && { launchOptions: request.launchOptions }),
        ...(request.contextOptions !== undefined && { contextOptions: request.contextOptions }),
        stealth: request.stealth,
        stealthDriver: deps.stealthDriver,
        ...(ctx.identity !== undefined && { identity: ctx.identity }),
        proxy: ctx.proxy,
        downloadsDir: dirs.downloads,
        tracing: {
          enabled: deps.trace,
          screenshots: deps.screenshotTrace,
          snapshots: true,
          partsDir: dirs.traceParts,
        },
      };
      const handle = await launchRaced(deps, spec, signal, deadlineMs);
      ctx.handle = handle;
      compensate(stack, log, 'launch', async () => {
        await handle.close(deps.closeTimeoutMs);
      });
      const now = deps.clock.now();
      session.attach({
        handle,
        driver: handle.driver,
        launchedAt: now,
        launchMs: now - session.createdAt,
      });
      handle.onCrash((reason) => hooks.crashed(session, reason));
      for (const warning of handle.warnings) {
        if (TRACING_CODES.has(warning.code) || IDENTITY_CODES.has(warning.code)) continue;
        hooks.warn(session, warningFromLaunch(session.id, warning));
      }
    },
    installPolicies: async (ctx) => {
      const session = need(ctx.session, 'session');
      const handle = need(ctx.handle, 'handle');
      if (deps.policies === undefined) return;
      const warnings = await deps.policies.install(handle, { sessionId: session.id });
      for (const warning of warnings) hooks.warn(session, warningFromLaunch(session.id, warning));
    },
    startTracing: async (ctx) => {
      // The driver starts tracing during `launch` (port contract: `LaunchSpec.tracing`); this phase
      // confirms the outcome and surfaces a failed start as the session's own warning.
      const session = need(ctx.session, 'session');
      const handle = need(ctx.handle, 'handle');
      if (!deps.trace) return;
      for (const warning of handle.warnings) {
        if (TRACING_CODES.has(warning.code))
          hooks.warn(session, warningFromLaunch(session.id, warning));
      }
    },
    applyIdentity: async (ctx) => {
      const request = need(ctx.request, 'request');
      const session = need(ctx.session, 'session');
      const handle = need(ctx.handle, 'handle');
      if (!request.stealth) return;
      // The override is page-scoped and awaitable: wait before the agent can drive the first page.
      await handle.ensureIdentityForPage(handle.page);
      session.setIdentity(handle.identity);
      for (const warning of handle.warnings) {
        if (IDENTITY_CODES.has(warning.code))
          hooks.warn(session, warningFromLaunch(session.id, warning));
      }
    },
    register: async (ctx) => {
      const session = need(ctx.session, 'session');
      const handle = need(ctx.handle, 'handle');
      session.tabs.add(handle.page);
      // Site-opened pages (target=_blank, window.open) get an id too, so list_tabs stays accurate.
      handle.context.on('page', (page) => {
        session.tabs.add(page);
      });
      session.apply({ type: 'launched', at: deps.clock.now() });
      hooks.updated(session);
    },
  };
}

function authStates(deps: PipelineDeps, name: string, kind: 'storage' | 'profile') {
  const locator = deps.authStates;
  if (locator !== undefined) return locator;
  const label = kind === 'profile' ? 'full-profile' : 'storage-state';
  throw new AppError(
    'AUTH_STATE_NOT_FOUND',
    { name, kind },
    {
      publicMessage: `No saved ${label} snapshot named '${name}'. Use list_saved_auths to see what is available.`,
    },
  );
}

/**
 * Launches under the deadline. A driver that ignores the signal may still resolve later; the
 * orphaned handle is then closed so no browser process outlives its failed launch.
 */
async function launchRaced(
  deps: PipelineDeps,
  spec: LaunchSpec,
  signal: AbortSignal,
  deadlineMs: number,
): Promise<SessionHandle> {
  let settled = false;
  const launching = deps.driver.launch(spec, signal);
  launching
    .then((handle) => {
      if (!settled) return;
      void handle.close(deps.closeTimeoutMs).catch(() => undefined);
    })
    .catch(() => undefined);
  try {
    return await raceSignal(launching, signal, 'browser launch', deadlineMs);
  } catch (err) {
    settled = true;
    throw err;
  } finally {
    settled = true;
  }
}
