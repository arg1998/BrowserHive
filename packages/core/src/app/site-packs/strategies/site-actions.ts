/** @module app/site-packs/strategies/site-actions — the before-action strategies of site packs (spec 13 §9.4, §9.6 "Before navigation and element actions"): `serialize-site`, `human-dwell`, `entry-warmup`, `humanize-input` (with `stealth-profile.humanize`) and `single-focus`, for agents' live template sessions only, scoped by the approved pack owning the page's URL and counted per template. Waits look like latency; the only refusal is `TEMPLATE_BUSY` `pace`. State is in memory, per process (lead decision 1), except the `human-dwell` last actions a restart carries over (`dwellMemory`, D53). */

import type { Session } from '../../../domain/session/session.ts';
import type { SessionTemplate } from '../../../domain/session/session-template.ts';
import { hostOf, templateSiteOf } from '../../../domain/site-packs/site-of-url.ts';
import { strategyOf } from '../../../domain/site-packs/strategy-params.ts';
import { registrableDomain } from '../../../kernel/url.ts';
import type { Clock } from '../../../ports/clock.ts';
import type { Logger } from '../../../ports/logger.ts';
import type { PageFocusControl } from '../../../ports/page-focus.ts';
import type { Page } from '../../../ports/page-types.ts';
import type { TemplateSiteRecord } from '../../../ports/persistence/index.ts';
import type { EffectivePack, SitePackLookup } from '../../../ports/site-packs.ts';
import { pageStrategy } from '../strategy-scope.ts';
import { actionKindOf, URL_TARGET_TOOLS } from './action-tools.ts';
import { type DwellMemory, SiteDwell } from './dwell.ts';
import { EntryWarmup, warmupBudget, warmupPlan } from './entry-warmup.ts';
import { templatePaced } from './pace-busy.ts';
import { SingleFocus } from './single-focus.ts';
import { SiteSlots, type SlotTurn } from './site-slots.ts';

/** One tool call on a session, as the dispatcher sees it. */
export interface SiteActionCall {
  readonly tool: string;
  readonly args: Readonly<Record<string, unknown>>;
  readonly session: Session;
  readonly signal: AbortSignal;
}

/** The navigation a tool is about to make in `page` (`navigate`, `new_tab` with a `url`). */
export interface SiteGotoCall {
  readonly tool: string;
  readonly session: Session;
  readonly page: Page;
  readonly url: string;
  /** The tool's timeout (`0`: none). */
  readonly timeoutMs: number;
  readonly signal: AbortSignal;
  /** The call's site gate; after a warm-up it runs again before the agent's own navigation. */
  readonly recheck?: (() => Promise<void>) | null;
}

/** Collaborators of {@link SiteActionStrategies}. */
export interface SiteActionStrategiesDeps {
  /** The registry's read side; `null` under `sitePacks=false` (every strategy is inert). */
  readonly lookup: () => SitePackLookup | null;
  /** The template's sites (`TEMPLATE_BUSY` names the template's site). */
  readonly sites: (templateId: string) => Promise<readonly TemplateSiteRecord[]>;
  /** The tab's page (`SessionService.page`). @throws `TAB_NOT_FOUND` */
  readonly pageOf: (session: Session, tabId?: string) => Page;
  /** The session's pages. */
  readonly pagesOf: (session: Session) => readonly Page[];
  /** Every session of the process. */
  readonly sessions: () => readonly Session[];
  /** `null`: `single-focus` is inert. */
  readonly focus: PageFocusControl | null;
  /** The agent's own navigations (challenge exemption, spec 13 §9.5). */
  readonly navigations: { expectOnPage(page: object, url: string): void };
  readonly clock: Clock;
  /** Draws from [0, 1) (`human-dwell`). */
  readonly random: () => number;
  readonly logger: Logger;
  /** Test seam: the `serialize-site` wait (production: 30 s). */
  readonly serializeWaitMs?: number;
  /** The `human-dwell` last actions across a restart (D53); absent: in memory only. */
  readonly dwellMemory?: DwellMemory;
}

/** The runner the dispatcher wraps tool handlers in. */
export class SiteActionStrategies {
  readonly #deps: SiteActionStrategiesDeps;
  readonly #log: Logger;
  readonly #slots: SiteSlots;
  readonly #dwell: SiteDwell;
  readonly #warmup: EntryWarmup;
  readonly #focus: SingleFocus | null;
  /** (session, pack) pairs whose first navigation happened. */
  readonly #visited = new Set<string>();
  /** Templates whose forced humanize was ignored (stealth `off`): logged once. */
  readonly #stealthOff = new Set<string>();

  constructor(deps: SiteActionStrategiesDeps) {
    this.#deps = deps;
    this.#log = deps.logger.child({ module: 'site-packs.actions' });
    this.#slots = new SiteSlots(deps.clock, deps.serializeWaitMs);
    this.#dwell = new SiteDwell(deps.random, deps.dwellMemory ?? null);
    this.#warmup = new EntryWarmup(deps.clock, this.#log);
    const focus = deps.focus;
    this.#focus =
      focus === null
        ? null
        : new SingleFocus({
            focus,
            pagesOf: (templateId) => this.#livePages(templateId),
            singleFocusPackOf: (url) => this.#strategyPack(url, 'single-focus'),
            logger: deps.logger,
          });
  }

  /**
   * Runs `run` (the tool's handler) with the before-action strategies of the page it acts on:
   * `human-dwell` and `serialize-site` before it (the turn is released when it settles), and the
   * `single-focus` arbitration before and after it. A call that waited (a dwell, or a queue for its
   * turn) runs `recheck` (the dispatcher's site gate) after the wait and before anything acts: a
   * hold, stop, sign-in pause or guard that arrived meanwhile refuses it, and its turn is released.
   *
   * @throws `TEMPLATE_BUSY` (`pace`) when the turn did not come within 30 s; the signal's reason
   *   when the call is aborted while waiting; what `recheck` throws
   */
  async around<T>(
    call: SiteActionCall,
    run: () => Promise<T>,
    recheck: () => Promise<void> = async () => undefined,
  ): Promise<T> {
    const template = liveTemplate(call.session);
    const kind = template === null ? null : actionKindOf(call.tool, call.args);
    if (template === null || kind === null) return await run();
    const page = call.tool === 'new_tab' ? null : this.#page(call.session, call.args['tab_id']);
    const url = URL_TARGET_TOOLS.has(call.tool)
      ? hrefOf(call.args['url'])
      : page === null
        ? null
        : safeUrl(page);
    const pack = kind === 'focus' || url === null ? null : this.#packOf(url);
    let turn: SlotTurn | null = null;
    if (pack !== null && url !== null) {
      if (kind === 'interaction') this.#visited.add(pairKey(call.session.id, pack.packId));
      const dwelt = await this.#dwellBefore(call, pack);
      turn = await this.#serialize(call, template, pack, url);
      if (dwelt || turn?.queued === true) {
        try {
          await recheck();
        } catch (err) {
          turn?.release();
          throw err;
        }
      }
    }
    try {
      if (page !== null && kind !== 'focus') {
        await this.#focus?.arbitrate(template.templateId, page, call.session.request.headless);
      }
      return await run();
    } finally {
      turn?.release();
      await this.#focusAfter(call, template);
      // The dwell counts from the end of the whole action, its focus hand-back included.
      if (pack !== null) {
        this.#dwell.record(call.session.id, pack.packId, this.#deps.clock.now());
      }
    }
  }

  /**
   * The `entry-warmup` of a navigation about to load `call.url` in `call.page`: on the session's
   * first navigation to a site whose pack selects it, a deep link first loads the entry path.
   * Resolves with the milliseconds it used (the navigation's timeout shrinks by that much).
   *
   * @throws the signal's reason when the call is aborted
   */
  async beforeGoto(call: SiteGotoCall): Promise<number> {
    const template = liveTemplate(call.session);
    if (template === null) return 0;
    const pack = this.#packOf(call.url);
    if (pack === null) return 0;
    const pair = pairKey(call.session.id, pack.packId);
    const first = !this.#visited.has(pair) && !this.#onSite(call.session, pack.packId);
    this.#visited.add(pair);
    if (!first) return 0;
    const params = strategyOf(pack.pack, 'entry-warmup');
    const plan = params === null ? null : warmupPlan(pack.pack, params, call.url);
    if (params === null || plan === null) return 0;
    const budget = warmupBudget(call.timeoutMs, plan.dwellMs);
    if (budget === null) {
      this.#log.info('warm-up skipped', {
        reason: 'the tool timeout is too short',
        templateId: template.templateId,
        pack: pack.packId,
      });
      return 0;
    }
    const startedAt = this.#deps.clock.now();
    await this.#warmup.run(call.page, pack.pack, plan, budget, call.signal);
    // The warm-up's commit consumed the expectation; the agent's own navigation is next.
    if (call.tool === 'navigate') this.#deps.navigations.expectOnPage(call.page, call.url);
    // A hold, stop or sign-in pause that arrived during the warm-up stops the agent's navigation.
    await call.recheck?.();
    const usedMs = this.#deps.clock.now() - startedAt;
    this.#log.info('entry warm-up', {
      templateId: template.templateId,
      sessionId: call.session.id,
      pack: pack.packId,
      path: params.path,
      referrer: params.referrer,
      usedMs,
    });
    return usedMs;
  }

  /**
   * True when the pack owning `url` forces humanized input (`humanize-input`, or
   * `stealth-profile` with `humanize: true`) for this live session. Ignored, and logged once per
   * template, when the template's stealth is `off`.
   */
  forcesHumanize(session: Session, url: string): boolean {
    const template = liveTemplate(session);
    if (template === null) return false;
    const lookup = this.#deps.lookup();
    const forced =
      pageStrategy(url, lookup, 'humanize-input') !== null ||
      pageStrategy(url, lookup, 'stealth-profile')?.params.humanize === true;
    if (!forced) return false;
    if (session.request.stealth) return true;
    if (!this.#stealthOff.has(template.templateId)) {
      this.#stealthOff.add(template.templateId);
      this.#log.warn('humanize not forced', {
        reason: 'the template has stealth off',
        templateId: template.templateId,
        host: hostOf(url),
      });
    }
    return false;
  }

  /** Re-checks every template's focus (a pack changed: it may no longer select `single-focus`). */
  async reconcile(): Promise<void> {
    const focus = this.#focus;
    if (focus === null) return;
    const ids = new Map<string, boolean>();
    for (const s of this.#deps.sessions()) {
      const template = liveTemplate(s);
      if (template !== null) ids.set(template.templateId, s.request.headless);
    }
    await Promise.all(
      [...ids.entries()].map(([id, headless]) => focus.arbitrate(id, null, headless)),
    );
  }

  /** A session closed: its dwell and first-visit state go. */
  sessionClosed(sessionId: string): void {
    this.#dwell.forget(sessionId);
    const prefix = `${sessionId}\u0000`;
    for (const k of this.#visited) if (k.startsWith(prefix)) this.#visited.delete(k);
    const live = new Set<string>();
    for (const s of this.#deps.sessions()) {
      const template = liveTemplate(s);
      if (template !== null && s.id !== sessionId) live.add(template.templateId);
    }
    this.#focus?.retain(live);
  }

  /** The `human-dwell` wait; true when the call waited. */
  async #dwellBefore(call: SiteActionCall, pack: EffectivePack): Promise<boolean> {
    const params = strategyOf(pack.pack, 'human-dwell');
    if (params === null) return false;
    const ms = this.#dwell.waitMs(call.session.id, pack.packId, params, this.#deps.clock.now());
    if (ms <= 0) return false;
    await this.#deps.clock.sleep(ms, call.signal);
    return true;
  }

  async #serialize(
    call: SiteActionCall,
    template: SessionTemplate,
    pack: EffectivePack,
    url: string,
  ): Promise<SlotTurn | null> {
    const params = strategyOf(pack.pack, 'serialize-site');
    if (params === null) return null;
    const key = pairKey(template.templateId, pack.packId);
    const turn = await this.#slots.acquire(key, call.session.id, params.maxParallel, call.signal);
    if (turn !== 'timeout') {
      if (turn.waitedMs > 0) {
        this.#log.debug('site action waited', {
          templateId: template.templateId,
          pack: pack.packId,
          waitedMs: turn.waitedMs,
        });
      }
      return turn;
    }
    const site = await this.#siteName(template.templateId, url, pack);
    this.#log.info('site action paced', {
      templateId: template.templateId,
      sessionId: call.session.id,
      pack: pack.packId,
      tool: call.tool,
      maxParallel: params.maxParallel,
    });
    throw templatePaced(template.name, site);
  }

  async #focusAfter(call: SiteActionCall, template: SessionTemplate): Promise<void> {
    const focus = this.#focus;
    if (focus === null) return;
    const tab = call.tool === 'new_tab' ? undefined : call.args['tab_id'];
    const page = this.#page(call.session, tab);
    await focus.arbitrate(template.templateId, page, call.session.request.headless);
  }

  /** The template's site of `url` (its id), else the URL's registrable domain. */
  async #siteName(templateId: string, url: string, pack: EffectivePack): Promise<string> {
    const sites = await this.#deps.sites(templateId).catch(() => []);
    const site = templateSiteOf(sites, url, () => pack.packId);
    if (site !== null) return site.siteId;
    const host = hostOf(url);
    return host === null ? pack.packId : registrableDomain(host) || host;
  }

  #packOf(url: string): EffectivePack | null {
    const host = hostOf(url);
    if (host === null) return null;
    return this.#deps.lookup()?.effectiveFor(host) ?? null;
  }

  #strategyPack(url: string, id: 'single-focus'): string | null {
    return pageStrategy(url, this.#deps.lookup(), id)?.pack.packId ?? null;
  }

  /** True when a page of the session already shows the pack's site. */
  #onSite(session: Session, packId: string): boolean {
    try {
      return this.#deps.pagesOf(session).some((p) => this.#packOf(safeUrl(p))?.packId === packId);
    } catch {
      return false;
    }
  }

  #livePages(templateId: string): Page[] {
    const pages: Page[] = [];
    for (const s of this.#deps.sessions()) {
      if (liveTemplate(s)?.templateId !== templateId) continue;
      try {
        pages.push(...this.#deps.pagesOf(s));
      } catch {
        // A session closing meanwhile has no pages.
      }
    }
    return pages;
  }

  #page(session: Session, tabId: unknown): Page | null {
    try {
      return this.#deps.pageOf(session, typeof tabId === 'string' ? tabId : undefined);
    } catch {
      // The handler raises `TAB_NOT_FOUND` itself.
      return null;
    }
  }
}

/** The template of an agent's live session; `null` for exclusive and maintenance sessions. */
function liveTemplate(session: Session): SessionTemplate | null {
  const template = session.template;
  return template !== null && template.mode === 'live' ? template : null;
}

function pairKey(a: string, b: string): string {
  return `${a}\u0000${b}`;
}

function hrefOf(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  try {
    return new URL(value.trim()).href;
  } catch {
    return null;
  }
}

function safeUrl(page: Page): string {
  try {
    return page.url();
  } catch {
    return 'about:blank';
  }
}
