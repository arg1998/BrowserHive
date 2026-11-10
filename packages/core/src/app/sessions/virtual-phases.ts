/** @module app/sessions/virtual-phases — the template branch of the D-21 creation pipeline (spec 13 §3.7): same phase names, spans and compensators; the host is acquired instead of a browser launched. */

import { assertAdmitted } from '../../domain/session/admission.ts';
import { validateCreateRequest } from '../../domain/session/create-request.ts';
import { Session } from '../../domain/session/session.ts';
import { AppError } from '../../kernel/errors/app-error.ts';
import type { Logger } from '../../ports/logger.ts';
import type { TemplatePageOptions } from '../../ports/template-host.ts';
import {
  compensate,
  type PhaseName,
  type PhaseRunner,
  type PipelineContext,
  type VirtualSessionLauncher,
} from './pipeline-context.ts';
import type { PipelineDeps, PipelineHooks } from './pipeline-deps.ts';
import { prepareSessionDirs, removeSessionDir } from './profile-dir.ts';

/** The per-session context options of a validated request (spec 13 §4). */
function pageOptionsOf(ctx: PipelineContext): TemplatePageOptions {
  const options = ctx.request?.contextOptions;
  if (options === undefined) return {};
  return {
    ...(options.viewport !== undefined && { viewport: options.viewport }),
    ...(options.extraHTTPHeaders !== undefined && { extraHTTPHeaders: options.extraHTTPHeaders }),
    ...(options.colorScheme !== undefined && { colorScheme: options.colorScheme }),
  };
}

/**
 * Replaces the phases that differ for a virtual session (spec 13 §3.7 table). `admit` is the
 * template admission, run once before the pipeline; `installPolicies` has nothing to do (the host
 * owns its interception chain and resolves each request's owner); `startTracing` is off (§5.4).
 */
export function virtualPhases(
  deps: PipelineDeps,
  virtual: VirtualSessionLauncher,
  hooks: PipelineHooks,
  log: Logger,
  stack: AsyncDisposableStack,
  signal: AbortSignal,
): Partial<Record<PhaseName, PhaseRunner>> {
  const need = <T>(value: T | undefined, what: string): T => {
    if (value === undefined) throw new AppError('INTERNAL_ERROR', { ref: `pipeline-${what}` });
    return value;
  };
  return {
    validate: async (ctx) => {
      ctx.request = {
        ...validateCreateRequest(deps.input, deps.defaults, deps.principal),
        template: virtual.template,
      };
    },
    admit: async () => undefined,
    reserve: async (ctx) => {
      const request = need(ctx.request, 'request');
      let giveBack: () => void = () => undefined;
      const session = await deps.registry.withLock(() => {
        giveBack = virtual.reserve(() =>
          assertAdmitted(deps.admission, {
            occupied: deps.occupiedSlots(),
            slug: request.slug,
            principal: request.owner,
          }),
        );
        const created = new Session({
          id: deps.ids.sessionId(request.slug),
          request,
          createdAt: deps.clock.now(),
          leaseWindowMs: deps.leaseWindowMs,
          tabId: () => deps.ids.tabId(),
        });
        try {
          deps.registry.reserve(created);
        } catch (err) {
          giveBack();
          throw err;
        }
        return created;
      });
      ctx.session = session;
      compensate(stack, log, 'reserve', async () => {
        deps.registry.release(session.id);
        giveBack();
      });
      hooks.opened(session);
    },
    prepareProfile: async (ctx) => {
      const session = need(ctx.session, 'session');
      const dirs = deps.layout.forSession(session.id);
      await prepareSessionDirs(deps.fs, dirs, { persistent: false, trace: false });
      ctx.dirs = dirs;
      compensate(stack, log, 'prepareProfile', () => removeSessionDir(deps.fs, dirs));
      await virtual.acquire(signal);
    },
    resolveIdentity: async (ctx) => {
      // The host's pinned identity and proxy: nothing is resolved per session.
      need(ctx.session, 'session').setProxyLabel(virtual.proxyLabel);
    },
    launch: async (ctx) => {
      const session = need(ctx.session, 'session');
      const view = await virtual.open(session.id, { pageOptions: pageOptionsOf(ctx), signal });
      ctx.view = view;
      compensate(stack, log, 'launch', async () => {
        await view.close(deps.closeTimeoutMs);
      });
      const now = deps.clock.now();
      session.attach({
        view,
        driver: view.host.driver,
        launchedAt: now,
        launchMs: now - session.createdAt,
      });
      view.onCrash((reason) => hooks.crashed(session, reason));
    },
    installPolicies: async () => undefined,
    startTracing: async () => undefined,
  };
}
