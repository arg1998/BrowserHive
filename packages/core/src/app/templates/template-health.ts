/** @module app/templates/template-health — probing a template's sites (spec 13 §8.1–§8.3): one probe at a time per template, a `template_probes` row and a health update per site, the `templates` topic events, and the sign-in transitions the notifications and auto-relogin react to. */

import type { TemplateSiteView } from '@browserhive/contracts/http';
import {
  healthAfter,
  type ProbeVerdict,
  providerOf,
  sitesOfProvider,
} from '../../domain/templates/probe.ts';
import type { JarCookie } from '../../domain/templates/sign-ins.ts';
import { AppError } from '../../kernel/errors/app-error.ts';
import { serializeError } from '../../kernel/errors/serialize-error.ts';
import { registrableDomain } from '../../kernel/url.ts';
import type { Clock } from '../../ports/clock.ts';
import type { EventPublisher } from '../../ports/event-bus.ts';
import type { Logger } from '../../ports/logger.ts';
import type {
  Repositories,
  TemplateProbeTrigger,
  TemplateRecord,
  TemplateSiteRecord,
} from '../../ports/persistence/index.ts';
import type { TemplateHost } from '../../ports/template-host.ts';
import type { DomainEvents, SigninTransition } from '../events/catalog.ts';
import { type ProberSelector, selectGenericProber } from './site-prober.ts';
import { notFoundForOperator, validationFailed } from './template-errors.ts';
import { toSiteView } from './views.ts';

/** One probe of one site. */
export interface SiteProbeResult {
  readonly siteId: string;
  readonly outcome: ProbeVerdict['outcome'];
  readonly reason: string;
  readonly durationMs: number;
}

/** How a probe gets the template's browser. */
export interface ProbeHosts {
  /** The running browser, or `null`. */
  runningHost(templateId: string): TemplateHost | null;
  /** Runs `fn` on the browser, starting it through BrowserHive's own maintenance session. */
  withHost<T>(template: TemplateRecord, fn: (host: TemplateHost) => Promise<T>): Promise<T>;
  /** A browser slot is free for a start (spec 13 §6.3). */
  slotFree(): boolean;
  /** The cookies of a stopped browser's last checkpoint, or `null` (none, or no key). */
  storedJar?(templateId: string): Promise<readonly JarCookie[] | null>;
}

/** Where a probe reads the jar from: the running browser, or a stopped one's checkpoint. */
interface ProbeSource {
  readonly host: TemplateHost | null;
  readonly jar: () => Promise<readonly JarCookie[]>;
}

function browserJar(host: TemplateHost): ProbeSource {
  return { host, jar: () => host.jar() };
}

/** When a probe may start a stopped browser. */
export type ProbeStart = 'always' | 'if_slot_free' | 'never';

/** Options of {@link TemplateHealthService.probe}. */
export interface ProbeOptions {
  readonly trigger: TemplateProbeTrigger;
  /** Sites to probe (registrable domains); default every enabled site. */
  readonly siteIds?: readonly string[];
  readonly start: ProbeStart;
  /** A pause between two sites (the schedule's 5–20 s gap). */
  readonly gapMs?: () => number;
  readonly signal?: AbortSignal;
}

/** Hooks other services attach after composition. */
export interface HealthHooks {
  /** A site became `signed_out` (vault auto-relogin, spec 13 §8.4). Never throws. */
  signedOut?(template: TemplateRecord, site: TemplateSiteRecord): void;
}

/** Collaborators of {@link TemplateHealthService}. */
export interface TemplateHealthDeps {
  readonly repos: Pick<Repositories, 'templates' | 'templateSites' | 'templateProbes'>;
  readonly hosts: ProbeHosts;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly bus?: EventPublisher<DomainEvents>;
  /** The template's summary changed (`template.changed`). */
  readonly changed?: (templateId: string) => void;
  /** The machine sign-in windows open on (notification copy). */
  readonly machine: string;
  readonly probers?: ProberSelector;
}

/** Result of a probe run: `null` when skipped (no free browser slot for a scheduled start). */
export type ProbeRun = readonly SiteProbeResult[] | null;

/** Probes, health and the sign-in transitions of every template. */
export class TemplateHealthService {
  readonly #deps: TemplateHealthDeps;
  readonly #log: Logger;
  readonly #probers: ProberSelector;
  /** The tail of each template's probe chain: one probe run at a time per template. */
  readonly #tails = new Map<string, Promise<unknown>>();
  readonly #inFlight = new Map<string, number>();
  #hooks: HealthHooks = {};

  constructor(deps: TemplateHealthDeps) {
    this.#deps = deps;
    this.#log = deps.logger.child({ module: 'templates.health' });
    this.#probers = deps.probers ?? selectGenericProber;
  }

  /** Attaches the hooks (auto-relogin). */
  attach(hooks: HealthHooks): void {
    this.#hooks = hooks;
  }

  /** True while a probe run of the template is queued or running. */
  probing(templateId: string): boolean {
    return (this.#inFlight.get(templateId) ?? 0) > 0;
  }

  /** Resolves once the template's queued probe runs are done (never rejects). */
  async settled(templateId: string): Promise<void> {
    await this.#tails.get(templateId)?.catch(() => undefined);
  }

  /**
   * Probes the template's sites one after the other (spec 13 §8.1, §8.3), after any run already
   * queued for it.
   *
   * @throws AppError `TEMPLATE_NOT_FOUND`, `VALIDATION_FAILED` (a site that is not the template's),
   *   and the browser-start refusals when `start: 'always'`.
   */
  async probe(templateId: string, options: ProbeOptions): Promise<ProbeRun> {
    const template = await this.#deps.repos.templates.get(templateId);
    if (template === null) throw notFoundForOperator(templateId);
    const sites = await this.#deps.repos.templateSites.list(templateId);
    const chosen = this.#chosen(sites, options.siteIds);
    this.#inFlight.set(templateId, (this.#inFlight.get(templateId) ?? 0) + 1);
    const run = (this.#tails.get(templateId) ?? Promise.resolve())
      .catch(() => undefined)
      .then(() => this.#run(template, chosen, options));
    this.#tails.set(templateId, run);
    try {
      return await run;
    } finally {
      const left = (this.#inFlight.get(templateId) ?? 1) - 1;
      if (left <= 0) this.#inFlight.delete(templateId);
      else this.#inFlight.set(templateId, left);
      if (this.#tails.get(templateId) === run) this.#tails.delete(templateId);
    }
  }

  /**
   * Records a sign-in state BrowserHive learned outside a probe (a re-login that signed the site in)
   * as a probe row with its trigger, and applies it like one.
   */
  async record(
    template: TemplateRecord,
    siteId: string,
    verdict: ProbeVerdict,
    trigger: TemplateProbeTrigger,
  ): Promise<void> {
    // On the template's probe chain, so it never interleaves with a probe's read-modify-write.
    const id = template.templateId;
    const run = (this.#tails.get(id) ?? Promise.resolve())
      .catch(() => undefined)
      .then(() => this.#apply(template, siteId, verdict, trigger, 0));
    this.#tails.set(id, run);
    try {
      await run;
    } finally {
      if (this.#tails.get(id) === run) this.#tails.delete(id);
    }
  }

  async #run(
    template: TemplateRecord,
    sites: readonly TemplateSiteRecord[],
    options: ProbeOptions,
  ): Promise<ProbeRun> {
    if (sites.length === 0) return [];
    const each = (host: TemplateHost) => this.#sites(template, sites, browserJar(host), options);
    const running = this.#deps.hosts.runningHost(template.templateId);
    if (running !== null) return each(running);
    // A stopped browser's cookies are its last checkpoint (written at every clean stop): sites
    // that need no navigation are checked from it, so a check never starts a window that could
    // take the operator's focus (review #81 e2e).
    const stored = this.#deps.hosts.storedJar;
    if (stored !== undefined && sites.every((s) => this.#probers(s).needsBrowser !== true)) {
      const jar = await stored(template.templateId);
      if (jar !== null)
        return this.#sites(template, sites, { host: null, jar: async () => jar }, options);
    }
    if (options.start === 'never') return null;
    if (options.start === 'if_slot_free' && !this.#deps.hosts.slotFree()) return null;
    return this.#deps.hosts.withHost(template, each);
  }

  async #sites(
    template: TemplateRecord,
    sites: readonly TemplateSiteRecord[],
    source: ProbeSource,
    options: ProbeOptions,
  ): Promise<SiteProbeResult[]> {
    const results: SiteProbeResult[] = [];
    for (const [i, chosen] of sites.entries()) {
      if (options.signal?.aborted === true) break;
      if (i > 0 && options.gapMs !== undefined) await this.#deps.clock.sleep(options.gapMs());
      // The site as it is now: learned names may have changed since the run was queued.
      const current = await this.#deps.repos.templateSites.list(template.templateId);
      const site = current.find((s) => s.siteId === chosen.siteId);
      if (site === undefined) continue;
      const started = this.#deps.clock.now();
      const verdict = await this.#probeOne(template, site, source, options.signal);
      const durationMs = Math.max(0, this.#deps.clock.now() - started);
      await this.#apply(template, site.siteId, verdict, options.trigger, durationMs);
      results.push({
        siteId: site.siteId,
        outcome: verdict.outcome,
        reason: verdict.reason,
        durationMs,
      });
    }
    return results;
  }

  async #probeOne(
    template: TemplateRecord,
    site: TemplateSiteRecord,
    source: ProbeSource,
    signal: AbortSignal | undefined,
  ): Promise<ProbeVerdict> {
    try {
      return await this.#probers(site).probe({
        template,
        site,
        host: source.host,
        jar: source.jar,
        now: this.#deps.clock.now(),
        signal: signal ?? new AbortController().signal,
      });
    } catch (err) {
      this.#log.warn('probe failed', {
        templateId: template.templateId,
        site: site.siteId,
        err: serializeError(err),
      });
      return { outcome: 'inconclusive', reason: 'network', finalUrl: null };
    }
  }

  /** Writes the probe row and the site's health, then publishes what changed. */
  async #apply(
    template: TemplateRecord,
    siteId: string,
    verdict: ProbeVerdict,
    trigger: TemplateProbeTrigger,
    durationMs: number,
  ): Promise<void> {
    const { repos, clock, bus } = this.#deps;
    const now = clock.now();
    const sites = await repos.templateSites.list(template.templateId);
    const site = sites.find((s) => s.siteId === siteId);
    if (site === undefined) return; // removed meanwhile
    const seq = await repos.templateProbes.insert({
      seq: 0,
      templateId: template.templateId,
      siteId,
      outcome: verdict.outcome,
      reason: verdict.reason,
      trigger,
      finalUrl: verdict.finalUrl,
      durationMs,
      at: now,
    });
    const health = healthAfter(site.health, verdict, now);
    await repos.templateSites.setHealth(template.templateId, siteId, health);
    const updated: TemplateSiteRecord = { ...site, health };
    const after = sites.map((s) => (s.siteId === siteId ? updated : s));
    bus?.publish('template.probe', {
      type: 'template.probe',
      template_id: template.templateId,
      probe: {
        seq,
        site_id: siteId,
        outcome: verdict.outcome,
        reason: verdict.reason,
        trigger,
        final_url: verdict.finalUrl,
        duration_ms: durationMs,
        at: now,
      },
    });
    const changed = site.health.state !== health.state;
    const view: TemplateSiteView = toSiteView(updated);
    bus?.publish('template.health', {
      type: 'template.health',
      template_id: template.templateId,
      site: view,
      ...(changed && { transition: this.#transition(template, site, updated, after, now) }),
    });
    if (!changed) return;
    this.#log.info('site sign-in changed', {
      templateId: template.templateId,
      site: siteId,
      from: site.health.state,
      to: health.state,
      reason: verdict.reason,
    });
    this.#deps.changed?.(template.templateId);
    if (health.state === 'signed_out') {
      try {
        this.#hooks.signedOut?.(template, updated);
      } catch (err) {
        this.#log.warn('signed-out hook failed', { err: serializeError(err) });
      }
    }
  }

  #transition(
    template: TemplateRecord,
    before: TemplateSiteRecord,
    after: TemplateSiteRecord,
    sites: readonly TemplateSiteRecord[],
    now: number,
  ): SigninTransition {
    const provider = providerOf(after);
    const group = sitesOfProvider(sites, provider);
    return {
      template: { name: template.name, display_name: template.displayName },
      provider,
      covers: group.map((s) => s.siteId),
      from: before.health.state,
      to: after.health.state,
      reason: after.health.reason,
      provider_signed_in: group.length > 0 && group.every((s) => s.health.state === 'signed_in'),
      machine: this.#deps.machine,
      at: now,
    };
  }

  #chosen(
    sites: readonly TemplateSiteRecord[],
    requested: readonly string[] | undefined,
  ): readonly TemplateSiteRecord[] {
    if (requested === undefined) return sites.filter((s) => s.enabled);
    const chosen = requested.map((raw) => {
      const id = registrableDomain(raw) || raw;
      const site = sites.find((s) => s.siteId === id);
      if (site === undefined) {
        throw validationFailed([
          {
            path: 'site_ids',
            message: `${raw} is not a site of this template`,
            code: 'unknown_site',
          },
        ]);
      }
      return site;
    });
    // Deduplicated after normalizing: `www.x.com` and `x.com` are one site, probed once.
    return [...new Set(chosen)];
  }
}

/** `CONFLICT` with an operator-facing message (re-login and probe routes). */
export function healthConflict(message: string): AppError<'CONFLICT'> {
  return new AppError('CONFLICT', {}, { publicMessage: message });
}
