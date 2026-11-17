/** @module app/site-packs/keeper — `keep-alive` (spec 13 §8.3, §9.4): for every ready template, each enabled site whose approved pack selects the strategy is visited with `GET` at the pack's keeper path (else its probe path) on the probe host, in a page of BrowserHive's own maintenance session, every `interval_h` ± 20 %, unless an agent session of the template loaded the site within the interval. A visit due outside the template's `active-hours` window (every enabled site's, in the template's time zone, as for launches) is deferred to the window's opening plus a random spread: an account restricted to 08–22 shows no keeper activity at 03:00 (review PR #84 L4). A visit doubles as a probe (trigger `schedule`): its outcome is recorded when it is the probe path, or when a keeper path still told something (signed out, challenged, a landmark). One visit at a time; in memory (a restart plans every site again from its last check). */

import { type ActiveWindow, msUntilActive } from '../../domain/site-packs/active-hours.ts';
import { jitteredKeeperMs, keeperStep } from '../../domain/site-packs/keeper-schedule.ts';
import type { ProbeVerdict } from '../../domain/templates/probe.ts';
import { assertNever } from '../../kernel/errors/app-error.ts';
import { serializeError } from '../../kernel/errors/serialize-error.ts';
import type { Clock } from '../../ports/clock.ts';
import type { Logger } from '../../ports/logger.ts';
import type {
  Repositories,
  TemplateRecord,
  TemplateSiteRecord,
} from '../../ports/persistence/index.ts';
import type { EffectivePack, SitePackLookup } from '../../ports/site-packs.ts';
import type { TemplateHost } from '../../ports/template-host.ts';
import type { SiteProbeContext } from '../templates/site-prober.ts';
import { templateStrategies } from './strategy-scope.ts';

/** A keeper visit's deadline (the probe navigation's 20 s plus its settling). */
export const KEEPER_VISIT_MS = 45_000;

/**
 * How far past the opening of the active hours a deferred visit lands, at random: visits of many
 * templates do not all fall on the hour, and the shortest window (one hour) still holds it.
 */
export const KEEPER_HOURS_SPREAD_MS = 20 * 60_000;

/** When the sites' windows never overlap, a deferred visit looks again a day later. */
const NO_WINDOW_RETRY_MS = 24 * 3_600_000;

/** How the keeper gets a template's browser (the probes' `ProbeHosts`). */
export interface KeeperHosts {
  runningHost(templateId: string): TemplateHost | null;
  /** Runs `fn` on the browser, starting it through BrowserHive's own maintenance session. */
  withHost<T>(template: TemplateRecord, fn: (host: TemplateHost) => Promise<T>): Promise<T>;
  /** A browser slot is free for a start (spec 13 §6.3). */
  slotFree(): boolean;
}

/** Collaborators of {@link SiteKeeper}. */
export interface SiteKeeperDeps {
  readonly repos: Pick<Repositories, 'templates' | 'templateSites'>;
  readonly lookup: () => SitePackLookup | null;
  /** The last agent load of a site's domains (`AgentSiteVisits`). */
  readonly visits: { lastLoad(templateId: string, domains: readonly string[]): number | null };
  readonly hosts: KeeperHosts;
  /** One visit (`PackProber.visit`): `path` on the probe host, `null` = the probe path. */
  readonly visit: (ctx: SiteProbeContext, path: string | null) => Promise<ProbeVerdict>;
  /** Records a visit's verdict as a probe (`TemplateHealthService.record`, trigger `schedule`). */
  readonly record: (
    template: TemplateRecord,
    siteId: string,
    verdict: ProbeVerdict,
  ) => Promise<void>;
  readonly clock: Clock;
  /** Uniform in `[0, 1)` (the ± 20 % jitter). */
  readonly random: () => number;
  readonly logger: Logger;
}

/** What one tick did for a site (tests, logs). */
export type KeeperOutcome =
  | { readonly kind: 'visited'; readonly verdict: ProbeVerdict; readonly recorded: boolean }
  | {
      readonly kind: 'skipped';
      readonly reason: 'agent_load' | 'outside_hours' | 'not_signed_in' | 'no_slot' | 'failed';
    };

/** The keeper of every template. */
export class SiteKeeper {
  readonly #deps: SiteKeeperDeps;
  readonly #log: Logger;
  /** When each (template, site) is next due. */
  readonly #due = new Map<string, number>();
  #running = false;

  constructor(deps: SiteKeeperDeps) {
    this.#deps = deps;
    this.#log = deps.logger.child({ module: 'site-packs.keeper' });
  }

  /** When a site is next due, or `undefined` before its first tick. */
  dueAt(templateId: string, siteId: string): number | undefined {
    return this.#due.get(keyOf(templateId, siteId));
  }

  /**
   * One pass over every template; visits the due sites one after the other. Never throws; a pass
   * still running makes the next one return at once. Resolves with what it did per site.
   */
  async tick(): Promise<ReadonlyMap<string, KeeperOutcome>> {
    const done = new Map<string, KeeperOutcome>();
    if (this.#running) return done;
    this.#running = true;
    try {
      const lookup = this.#deps.lookup();
      if (lookup === null) return done;
      const [templates, sites] = await Promise.all([
        this.#deps.repos.templates.listAll(),
        this.#deps.repos.templateSites.listAll(),
      ]);
      const live = new Set<string>();
      for (const template of templates) {
        if (template.status !== 'ready') continue;
        const own = sites.filter((s) => s.templateId === template.templateId);
        const hours = templateStrategies(own, lookup, 'active-hours').map((w) => w.params);
        for (const { site, pack, params } of templateStrategies(own, lookup, 'keep-alive')) {
          const key = keyOf(template.templateId, site.siteId);
          live.add(key);
          const outcome = await this.#site(template, site, pack, params.intervalH, hours);
          if (outcome !== null) done.set(key, outcome);
        }
      }
      for (const key of [...this.#due.keys()]) if (!live.has(key)) this.#due.delete(key);
    } catch (err) {
      this.#log.warn('keeper pass failed', { err: serializeError(err) });
    } finally {
      this.#running = false;
    }
    return done;
  }

  async #site(
    template: TemplateRecord,
    site: TemplateSiteRecord,
    pack: EffectivePack,
    intervalH: number,
    hours: readonly ActiveWindow[],
  ): Promise<KeeperOutcome | null> {
    const { clock, random } = this.#deps;
    const key = keyOf(template.templateId, site.siteId);
    const now = clock.now();
    let due = this.#due.get(key);
    if (due === undefined) {
      // First sight: one interval after the site's last check (a visit is a probe).
      due = (site.health.checkedAt ?? now) + jitteredKeeperMs(intervalH, random());
      this.#due.set(key, due);
    }
    const step = keeperStep({
      now,
      dueAt: due,
      lastAgentLoadAt: this.#deps.visits.lastLoad(template.templateId, pack.pack.domains),
      intervalH,
    });
    switch (step.kind) {
      case 'wait':
        return null;
      case 'skip':
        this.#due.set(key, step.from + jitteredKeeperMs(intervalH, random()));
        this.#log.debug('keeper visit skipped', {
          templateId: template.templateId,
          site: site.siteId,
        });
        return { kind: 'skipped', reason: 'agent_load' };
      case 'visit':
        break;
      default:
        return assertNever(step, 'keeper step');
    }
    const closedMs = msUntilActive(hours, template.identity.timezoneId, now);
    if (closedMs !== 0) {
      const wait = closedMs ?? NO_WINDOW_RETRY_MS;
      this.#due.set(key, now + wait + Math.floor(random() * KEEPER_HOURS_SPREAD_MS));
      this.#log.debug('keeper visit deferred', {
        templateId: template.templateId,
        site: site.siteId,
        reason: 'outside active hours',
      });
      return { kind: 'skipped', reason: 'outside_hours' };
    }
    // A site that is signed out or held by a security check has nothing to keep fresh, and
    // poking an anti-abuse checkpoint is what the design avoids (spec 13 §8.1): wait.
    const outcome: KeeperOutcome = ['signed_out', 'challenged'].includes(site.health.state)
      ? { kind: 'skipped', reason: 'not_signed_in' }
      : await this.#visit(template, site, pack);
    this.#due.set(key, clock.now() + jitteredKeeperMs(intervalH, random()));
    return outcome;
  }

  async #visit(
    template: TemplateRecord,
    site: TemplateSiteRecord,
    pack: EffectivePack,
  ): Promise<KeeperOutcome> {
    const path = pack.pack.keeper?.path ?? null;
    const signal = AbortSignal.timeout(KEEPER_VISIT_MS);
    const run = async (host: TemplateHost): Promise<KeeperOutcome> => {
      const verdict = await this.#deps.visit(
        { template, site, host, jar: () => host.jar(), now: this.#deps.clock.now(), signal },
        path,
      );
      // A keeper path that stayed put says nothing about the session: not a probe row.
      const recorded = path === null || verdict.outcome !== 'inconclusive';
      if (recorded) await this.#deps.record(template, site.siteId, verdict);
      this.#log.info('keeper visited site', {
        templateId: template.templateId,
        site: site.siteId,
        outcome: verdict.outcome,
      });
      return { kind: 'visited', verdict, recorded };
    };
    try {
      const running = this.#deps.hosts.runningHost(template.templateId);
      if (running !== null) return await run(running);
      // Like a scheduled check (spec 13 §8.3): a stopped browser starts only with a free slot.
      if (!this.#deps.hosts.slotFree()) return { kind: 'skipped', reason: 'no_slot' };
      return await this.#deps.hosts.withHost(template, run);
    } catch (err) {
      this.#log.warn('keeper visit failed', {
        templateId: template.templateId,
        site: site.siteId,
        err: serializeError(err),
      });
      return { kind: 'skipped', reason: 'failed' };
    }
  }
}

function keyOf(templateId: string, siteId: string): string {
  return `${templateId}\u0000${siteId}`;
}
