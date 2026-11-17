/** @module app/templates/template-prelaunch — the pre-launch health check (spec 13 §8.2): after the browser runs, a launch probes every enabled site whose last probe is older than 15 min, single-flight per template, within 10 s; `TEMPLATE_NEEDS_LOGIN` only when every enabled site is out. */

import { ERROR_REGISTRY, renderMessage } from '@browserhive/contracts/errors';
import { isOut, staleSites } from '../../domain/templates/probe.ts';
import { AppError } from '../../kernel/errors/app-error.ts';
import type { Clock } from '../../ports/clock.ts';
import type {
  Repositories,
  TemplateHealthState,
  TemplateRecord,
  TemplateSiteRecord,
} from '../../ports/persistence/index.ts';
import type { TemplateHealthService } from './template-health.ts';

/** A site probed longer ago than this is probed again before a launch. */
export const PRELAUNCH_MAX_AGE_MS = 15 * 60_000;
/** The longest a launch waits for its probes. */
export const PRELAUNCH_BUDGET_MS = 10_000;

/** What a launch learned: the sites (and their states for this launch) that are out. */
export interface PrelaunchResult {
  /** Enabled sites with their state for this launch (unfinished probes count `inconclusive`). */
  readonly sites: readonly { readonly site: string; readonly status: TemplateHealthState }[];
  /** Enabled sites that are signed out or challenged (the `TEMPLATE_SITE_SIGNED_OUT` warning). */
  readonly out: readonly string[];
}

/** One template's probes in flight, shared by concurrent launches. */
interface Flight {
  readonly startedAt: number;
  readonly done: Promise<unknown>;
}

/** Collaborators of {@link PrelaunchCheck}. */
export interface PrelaunchDeps {
  readonly repos: Pick<Repositories, 'templateSites'>;
  readonly health: Pick<TemplateHealthService, 'probe'>;
  readonly clock: Clock;
}

/** `TEMPLATE_NEEDS_LOGIN` (agent-facing; spec 13 §5 wording rules). */
export function needsLogin(
  template: string,
  sites: readonly string[],
): AppError<'TEMPLATE_NEEDS_LOGIN'> {
  const details = { template, sites: [...sites], sites_text: sites.join(', ') };
  return new AppError('TEMPLATE_NEEDS_LOGIN', details, {
    publicMessage: renderMessage(ERROR_REGISTRY.TEMPLATE_NEEDS_LOGIN.message, details),
  });
}

/** The pre-launch check of every template. */
export class PrelaunchCheck {
  readonly #deps: PrelaunchDeps;
  readonly #flights = new Map<string, Flight>();

  constructor(deps: PrelaunchDeps) {
    this.#deps = deps;
  }

  /**
   * Runs the check for one launch whose browser is running.
   *
   * @throws AppError `TEMPLATE_NEEDS_LOGIN` when every enabled site is out.
   */
  async check(
    template: TemplateRecord,
    signal?: AbortSignal,
    budgetMs: number = PRELAUNCH_BUDGET_MS,
  ): Promise<PrelaunchResult> {
    const { repos, clock } = this.#deps;
    const before = await repos.templateSites.list(template.templateId);
    if (!template.prelaunchCheck)
      return resultOf(
        before.filter((s) => s.enabled),
        new Set(),
      );
    const stale = staleSites(before, clock.now(), PRELAUNCH_MAX_AGE_MS);
    let pending = new Set<string>();
    if (stale.length > 0) {
      const flight = this.#flight(template, stale);
      await waitAtMost(flight.done, budgetMs, clock, signal);
      const after = await repos.templateSites.list(template.templateId);
      pending = new Set(
        stale
          .map((s) => after.find((a) => a.siteId === s.siteId))
          .filter((s): s is TemplateSiteRecord => s !== undefined)
          .filter((s) => (s.health.checkedAt ?? 0) < flight.startedAt)
          .map((s) => s.siteId),
      );
      const result = resultOf(
        after.filter((s) => s.enabled),
        pending,
      );
      return verdict(template, result);
    }
    return verdict(
      template,
      resultOf(
        before.filter((s) => s.enabled),
        pending,
      ),
    );
  }

  #flight(template: TemplateRecord, stale: readonly TemplateSiteRecord[]): Flight {
    const existing = this.#flights.get(template.templateId);
    if (existing !== undefined) return existing;
    const startedAt = this.#deps.clock.now();
    const done = this.#deps.health
      .probe(template.templateId, {
        trigger: 'prelaunch',
        siteIds: stale.map((s) => s.siteId),
        start: 'never',
      })
      .catch(() => undefined)
      .finally(() => this.#flights.delete(template.templateId));
    const flight = { startedAt, done };
    this.#flights.set(template.templateId, flight);
    return flight;
  }
}

function resultOf(
  enabled: readonly TemplateSiteRecord[],
  pending: ReadonlySet<string>,
): PrelaunchResult {
  const sites = enabled.map((s) => ({
    site: s.siteId,
    status: pending.has(s.siteId) ? ('inconclusive' as const) : s.health.state,
  }));
  return { sites, out: sites.filter((s) => isOut(s.status)).map((s) => s.site) };
}

function verdict(template: TemplateRecord, result: PrelaunchResult): PrelaunchResult {
  if (result.sites.length > 0 && result.out.length === result.sites.length) {
    throw needsLogin(template.name, result.out);
  }
  return result;
}

/** Resolves when `done` settles, `ms` pass or `signal` aborts, whichever comes first. */
async function waitAtMost(
  done: Promise<unknown>,
  ms: number,
  clock: Clock,
  signal: AbortSignal | undefined,
): Promise<void> {
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    await Promise.race([
      done,
      clock.sleep(ms, controller.signal).catch(() => undefined),
      new Promise<void>((resolve) => controller.signal.addEventListener('abort', () => resolve())),
    ]);
  } finally {
    controller.abort();
    signal?.removeEventListener('abort', onAbort);
  }
}
