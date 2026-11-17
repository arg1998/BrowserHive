/** @module app/templates/host-supervisor-launch — a virtual-session launch after the hold and pause checks (spec 13 §3.7, §6.3): `TemplateAdmission` once (host state, the effective cap and page caps, then the admission strategies), then the template branch of the session pipeline within the launch budget, a `launch-spacing` wait included. Split out of the host supervisor (D47). */

import type { Session } from '../../domain/session/session.ts';
import { effectiveCap, pageCaps } from '../../domain/templates/model.ts';
import type { TemplateLaunchRequest } from '../../ports/template-runtime.ts';
import type { AdmissionStrategies } from './admission-strategies.ts';
import type { PendingLaunches } from './host-events.ts';
import type { HostLifecycle } from './host-lifecycle.ts';
import { PAGE_LIMIT_MESSAGE, warnSession } from './host-memory.ts';
import { TEMPLATE_LAUNCH_BUDGET_MS } from './host-state.ts';
import type {
  HostSupervisorDeps,
  PrelaunchOutcome,
  SupervisorHealth,
} from './host-supervisor-types.ts';
import { reportPrelaunch } from './prelaunch-report.ts';
import { admitTemplateLaunch } from './template-admission.ts';
import { sessionTemplateOf, virtualLauncher, virtualSessionInput } from './virtual-launch.ts';

/** What one launch needs from the supervisor. */
export interface VirtualLaunchContext {
  readonly deps: Pick<HostSupervisorDeps, 'sessions' | 'templates' | 'clock' | 'config'>;
  readonly lifecycle: HostLifecycle;
  readonly strategies: AdmissionStrategies;
  readonly pending: PendingLaunches;
  readonly health: SupervisorHealth;
  /** Live agent virtual sessions of the template. */
  readonly liveSessions: number;
  /** What the launch already spent waiting for an open sign-in window (D-60). */
  readonly waitedMs: number;
}

/**
 * Admits and launches a virtual session. Admission is synchronous up to the pending count, so
 * concurrent launches can neither overshoot the cap nor take the same `launch-spacing` turn.
 *
 * @throws AppError `TEMPLATE_UNAVAILABLE`, `TEMPLATE_DISABLED`, `TEMPLATE_BUSY`, and the launch
 *   codes of the pipeline.
 */
export function launchVirtual(
  ctx: VirtualLaunchContext,
  request: TemplateLaunchRequest,
  signal?: AbortSignal,
): Promise<Session> {
  const { deps, lifecycle, strategies } = ctx;
  const { template } = request;
  const id = template.templateId;
  const budgetMs = TEMPLATE_LAUNCH_BUDGET_MS - ctx.waitedMs;
  const cap = effectiveCap(template, strategies.capLimits(template, request.sites));
  const caps = pageCaps(deps.config.maxPagesPerHost, cap);
  admitTemplateLaunch({
    name: template.name,
    state: lifecycle.state,
    retryAfterMs: lifecycle.restartAt === null ? null : lifecycle.restartAt - deps.clock.now(),
    agentSessions: ctx.liveSessions + ctx.pending.count(id),
    cap,
    agentPages: lifecycle.current?.agentPageCount() ?? 0,
    caps,
  });
  strategies.checkHours(template, request.sites);
  const turnMs = strategies.reserveTurn(template, request.sites, budgetMs);
  const session = sessionTemplateOf(template, request.sites, 'live', request.sealing);
  const prelaunch = ctx.health.prelaunch;
  let checked: PrelaunchOutcome | null = null;
  return ctx.pending.run(
    id,
    async (budget) => {
      // The `launch-spacing` turn: an ordinary-looking delay inside the launch budget.
      if (turnMs > 0) await deps.clock.sleep(turnMs, budget);
      const created = await deps.sessions.createVirtual(
        virtualSessionInput(request),
        request.principal,
        virtualLauncher({
          lifecycle,
          template,
          session,
          caps,
          onPageLimit: (sid) =>
            warnSession(deps.sessions, sid, 'SESSION_PAGE_LIMIT', PAGE_LIMIT_MESSAGE),
          ...(prelaunch !== undefined && {
            afterAcquire: async (s: AbortSignal) => {
              checked = await prelaunch(template, s);
            },
          }),
        }),
        { signal: budget, deadlineMs: TEMPLATE_LAUNCH_BUDGET_MS },
      );
      if (checked !== null) reportPrelaunch(deps.sessions, created, checked);
      const at = deps.clock.now();
      await deps.templates.touchLastUsed(id, at).catch(() => undefined);
      return created;
    },
    signal,
    budgetMs,
  );
}
