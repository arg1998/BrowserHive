/** @module app/templates/admission-strategies — the template-scoped strategies of `TemplateAdmission` (spec 13 §3.7, §6.3, §9.4, §9.6 "Admission of a virtual session"): the pack `concurrency.max_sessions` and `ramp-up` lower the cap; `active-hours` and `launch-spacing` refuse or space a launch. They come from the template's enabled sites' approved packs, the strictest site wins, and nothing applies under `sitePacks=false` (no lookup). The `launch-spacing` turn of each template is written through to the database and read back after a restart, so a restart never resets the spacing (D53). Agents only ever see `TEMPLATE_BUSY` `capacity` with `retry_after_ms`. */

import { msUntilActive } from '../../domain/site-packs/active-hours.ts';
import { rampFactor } from '../../domain/site-packs/strategy-params.ts';
import { type CapLimits, NO_CAP_LIMITS } from '../../domain/templates/model.ts';
import type { Clock } from '../../ports/clock.ts';
import type { Logger } from '../../ports/logger.ts';
import type { TemplateRecord, TemplateSiteRecord } from '../../ports/persistence/index.ts';
import type { SitePackLookup } from '../../ports/site-packs.ts';
import { packOfSite, templateStrategies } from '../site-packs/strategy-scope.ts';
import type { StrategyStateStore } from '../site-packs/strategy-state.ts';
import { templateBusy } from './template-admission.ts';

/** The longest a launch waits for its `launch-spacing` turn (spec 13 §3.7). */
export const LAUNCH_SPACING_MAX_WAIT_MS = 20_000;
/** `retry_after_ms` when the sites' active windows never overlap (an operator problem, logged). */
export const NO_WINDOW_RETRY_AFTER_MS = 86_400_000;

/** Collaborators of {@link AdmissionStrategies}. */
export interface AdmissionStrategiesDeps {
  readonly clock: Clock;
  readonly logger: Logger;
  /** The approved packs; `null` (or absent) under `sitePacks=false`. */
  readonly lookup?: () => SitePackLookup | null;
  /** In [0, 1); the `launch-spacing` jitter. */
  readonly random?: () => number;
  /** Persists the `launch-spacing` turns across a restart (D53); absent: in memory only. */
  readonly state?: StrategyStateStore;
}

/** The template-scoped admission strategies of every template. */
export class AdmissionStrategies {
  readonly #deps: AdmissionStrategiesDeps;
  readonly #random: () => number;
  /** Per template: the earliest instant the next launch may go (`launch-spacing`, FIFO). */
  readonly #nextTurn = new Map<string, number>();

  constructor(deps: AdmissionStrategiesDeps) {
    this.#deps = deps;
    this.#random = deps.random ?? Math.random;
  }

  #lookup(): SitePackLookup | null {
    return this.#deps.lookup?.() ?? null;
  }

  /**
   * What the enabled sites' packs do to the cap: the smallest `concurrency.max_sessions` and the
   * smallest `ramp-up` factor for the template's age.
   */
  capLimits(template: TemplateRecord, sites: readonly TemplateSiteRecord[]): CapLimits {
    const lookup = this.#lookup();
    if (lookup === null) return NO_CAP_LIMITS;
    let siteMax: number | null = null;
    for (const site of sites) {
      if (!site.enabled) continue;
      const max = packOfSite(site, lookup)?.pack.concurrency?.max_sessions;
      if (max !== undefined) siteMax = siteMax === null ? max : Math.min(siteMax, max);
    }
    const age = this.#deps.clock.now() - template.createdAt;
    const factors = templateStrategies(sites, lookup, 'ramp-up').map((s) =>
      rampFactor(s.params, age),
    );
    return { siteMax, rampFactor: Math.min(1, ...factors) };
  }

  /**
   * `active-hours`: a launch outside the window (every enabled site's, in the template's pinned
   * timezone) answers `TEMPLATE_BUSY` `capacity` with `retry_after_ms` until it opens.
   *
   * @throws AppError `TEMPLATE_BUSY`.
   */
  checkHours(template: TemplateRecord, sites: readonly TemplateSiteRecord[]): void {
    const windows = templateStrategies(sites, this.#lookup(), 'active-hours');
    if (windows.length === 0) return;
    const wait = msUntilActive(
      windows.map((w) => w.params),
      template.identity.timezoneId,
      this.#deps.clock.now(),
    );
    if (wait === 0) return;
    if (wait === null) {
      this.#deps.logger.warn('active hours never overlap', {
        templateId: template.templateId,
        sites: windows.map((w) => w.site.siteId),
      });
    }
    this.#deps.logger.info('launch outside hours', {
      templateId: template.templateId,
      retryAfterMs: wait ?? NO_WINDOW_RETRY_AFTER_MS,
    });
    throw templateBusy(template.name, 'capacity', wait ?? NO_WINDOW_RETRY_AFTER_MS);
  }

  /**
   * `launch-spacing`: reserves this launch's turn (synchronously, so concurrent launches queue
   * FIFO) and returns how long it must wait; a turn further away than `min(20 s, budgetMs)` is
   * refused with `TEMPLATE_BUSY` `capacity` and the time until it, and nothing is reserved. The
   * gap after a turn is the largest `min_gap_s` × (1 + a random jitter up to the largest
   * `jitter_pct`).
   *
   * @throws AppError `TEMPLATE_BUSY`.
   */
  reserveTurn(
    template: TemplateRecord,
    sites: readonly TemplateSiteRecord[],
    budgetMs: number,
  ): number {
    const spacing = templateStrategies(sites, this.#lookup(), 'launch-spacing');
    const gapS = Math.max(0, ...spacing.map((s) => s.params.minGapS));
    const id = template.templateId;
    if (gapS === 0) {
      this.#nextTurn.delete(id);
      this.#deps.state?.delete('launch-spacing', { templateId: id });
      return 0;
    }
    const now = this.#deps.clock.now();
    const saved =
      this.#nextTurn.get(id) ?? this.#deps.state?.get('launch-spacing', { templateId: id })?.nextAt;
    const turn = Math.max(now, saved ?? now);
    const wait = turn - now;
    if (wait > Math.min(LAUNCH_SPACING_MAX_WAIT_MS, Math.max(0, budgetMs))) {
      this.#deps.logger.info('launch spacing refused', { templateId: id, retryAfterMs: wait });
      throw templateBusy(template.name, 'capacity', wait);
    }
    const jitterPct = Math.max(0, ...spacing.map((s) => s.params.jitterPct));
    const jitter = Math.min(0.999_999, Math.max(0, this.#random())) * (jitterPct / 100);
    const nextAt = turn + Math.round(gapS * 1000 * (1 + jitter));
    this.#nextTurn.set(id, nextAt);
    this.#deps.state?.set('launch-spacing', { templateId: id }, { nextAt }, 'now');
    return wait;
  }

  /** Forgets a deleted template's state. */
  forget(templateId: string): void {
    this.#nextTurn.delete(templateId);
  }
}
