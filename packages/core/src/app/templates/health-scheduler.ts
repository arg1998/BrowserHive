/** @module app/templates/health-scheduler — when templates are probed (spec 13 §8.3): every `health_interval` ±10 %, sites one after another 5–20 s apart, at most two browsers probing at once, a stopped browser started for the check when a browser slot is free; plus every site after each browser start, after a restore or seed, and when an attention request of one of the template's sessions resolves. */

import { jitteredInterval, siteGapMs } from '../../domain/templates/probe.ts';
import { serializeError } from '../../kernel/errors/serialize-error.ts';
import type { Clock } from '../../ports/clock.ts';
import type { Logger } from '../../ports/logger.ts';
import type {
  Repositories,
  TemplateProbeTrigger,
  TemplateRecord,
  TemplateSiteRecord,
} from '../../ports/persistence/index.ts';
import type { ProbeStart, TemplateHealthService } from './template-health.ts';

/** At most this many templates are probed by the schedule at the same time (spec 13 §8.3). */
export const MAX_PROBING_HOSTS = 2;
/** A browser start does not probe again when a probe of the template ran this recently. */
const RECENT_PROBE_MS = 60_000;

/** Collaborators of {@link HealthScheduler}. */
export interface HealthSchedulerDeps {
  readonly repos: Pick<Repositories, 'templates' | 'templateSites'>;
  readonly health: Pick<TemplateHealthService, 'probe' | 'probing'>;
  readonly clock: Clock;
  /** Uniform in `[0, 1)` (jitter and gaps; injectable for tests). */
  readonly random: () => number;
  readonly logger: Logger;
}

/** The probe schedule of every template. */
export class HealthScheduler {
  readonly #deps: HealthSchedulerDeps;
  readonly #log: Logger;
  /** When each template is next due. */
  readonly #due = new Map<string, number>();
  /** Templates the schedule is probing now. */
  readonly #running = new Set<string>();
  /** When each template was last probed by anything this scheduler started. */
  readonly #last = new Map<string, number>();

  constructor(deps: HealthSchedulerDeps) {
    this.#deps = deps;
    this.#log = deps.logger.child({ module: 'templates.schedule' });
  }

  /** The templates the schedule is probing now (tests, operator views). */
  running(): readonly string[] {
    return [...this.#running];
  }

  /** When a template is next due, or `undefined` before its first tick. */
  dueAt(templateId: string): number | undefined {
    return this.#due.get(templateId);
  }

  /**
   * One pass: starts the due templates, at most {@link MAX_PROBING_HOSTS} at a time. Never throws;
   * the composition calls it on an interval. Resolves once the runs it started are done.
   */
  async tick(): Promise<void> {
    const runs: Promise<void>[] = [];
    try {
      const { templates, sites } = await this.#read();
      const now = this.#deps.clock.now();
      const live = new Set(templates.map((t) => t.templateId));
      for (const id of [...this.#due.keys()]) if (!live.has(id)) this.#due.delete(id);
      for (const template of templates) {
        if (template.status !== 'ready') continue;
        const enabled = (sites.get(template.templateId) ?? []).filter((s) => s.enabled);
        if (enabled.length === 0) continue;
        const due = this.#dueOf(template, enabled, now);
        if (now < due || this.#running.has(template.templateId)) continue;
        if (this.#running.size >= MAX_PROBING_HOSTS) break;
        runs.push(this.#scheduled(template));
      }
    } catch (err) {
      this.#log.warn('probe schedule failed', { err: serializeError(err) });
    }
    await Promise.all(runs);
  }

  /** Every site after a browser start (spec 13 §8.3); skipped right after a probe of the template. */
  hostStarted(templateId: string): void {
    const last = this.#last.get(templateId);
    if (this.#deps.health.probing(templateId)) return;
    if (last !== undefined && this.#deps.clock.now() - last < RECENT_PROBE_MS) return;
    this.#fire(templateId, 'host_start', 'never');
  }

  /** Every site after a restore or seed. */
  restored(templateId: string): void {
    this.#fire(templateId, 'restore', 'if_slot_free');
  }

  /** Every site when an attention request of a session of the template resolves. */
  attentionResolved(templateId: string): void {
    this.#fire(templateId, 'attention', 'never');
  }

  #fire(templateId: string, trigger: TemplateProbeTrigger, start: ProbeStart): void {
    this.#last.set(templateId, this.#deps.clock.now());
    this.#deps.health
      .probe(templateId, { trigger, start })
      .catch((err: unknown) =>
        this.#log.warn('probe failed', { templateId, trigger, err: serializeError(err) }),
      );
  }

  async #scheduled(template: TemplateRecord): Promise<void> {
    const id = template.templateId;
    this.#running.add(id);
    const { clock, random } = this.#deps;
    try {
      const run = await this.#deps.health.probe(id, {
        trigger: 'schedule',
        start: 'if_slot_free',
        gapMs: () => siteGapMs(random()),
      });
      if (run === null) this.#log.debug('probe skipped: no slot', { templateId: id });
      this.#last.set(id, clock.now());
    } catch (err) {
      this.#log.warn('scheduled probe failed', { templateId: id, err: serializeError(err) });
    } finally {
      this.#running.delete(id);
      // A skipped or failed run is retried at the next interval (spec 13 §8.3).
      this.#due.set(id, clock.now() + jitteredInterval(template.healthIntervalMs, random()));
    }
  }

  /** The first due time: one interval after the oldest check, or now for a site never checked. */
  #dueOf(template: TemplateRecord, enabled: readonly TemplateSiteRecord[], now: number): number {
    const known = this.#due.get(template.templateId);
    if (known !== undefined) return known;
    const checks = enabled.map((s) => s.health.checkedAt);
    const due = checks.some((c) => c === null)
      ? now
      : Math.min(...checks.map((c) => c ?? now)) +
        jitteredInterval(template.healthIntervalMs, this.#deps.random());
    this.#due.set(template.templateId, due);
    return due;
  }

  async #read(): Promise<{
    templates: readonly TemplateRecord[];
    sites: ReadonlyMap<string, readonly TemplateSiteRecord[]>;
  }> {
    const [templates, all] = await Promise.all([
      this.#deps.repos.templates.listAll(),
      this.#deps.repos.templateSites.listAll(),
    ]);
    const sites = new Map<string, TemplateSiteRecord[]>();
    for (const site of all) {
      const list = sites.get(site.templateId);
      if (list === undefined) sites.set(site.templateId, [site]);
      else list.push(site);
    }
    return { templates, sites };
  }
}
