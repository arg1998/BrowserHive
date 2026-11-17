/** @module app/site-packs/challenge-watch — challenge detection on the pages of template hosts (spec 13 §9.5), fail-open: a main-frame commit (URL rules), `domcontentloaded` (title, landmark, text) and provider frames that count only as a challenge surface (a challenge path, or a visible frame of at least 100 × 60 CSS px in the viewport, checked at the frame's `load` and 2 s later). Each rule is acted on once per document. */

import type { Frame, Page } from 'patchright';
import {
  type ChallengePageFacts,
  type ChallengeProvider,
  type ChallengeRule,
  challengeRulesFor,
  firstChallenge,
  isChallengePath,
  isVisibleSurface,
  providerOfFrameUrl,
} from '../../domain/site-packs/challenges.ts';
import { hostOf } from '../../domain/site-packs/site-of-url.ts';
import { serializeError } from '../../kernel/errors/serialize-error.ts';
import type { Clock } from '../../ports/clock.ts';
import type { Logger } from '../../ports/logger.ts';
import type { SitePackLookup } from '../../ports/site-packs.ts';
import type { AgentNavigations } from './agent-navigations.ts';
import type { DetectedChallenge } from './challenge-outcomes.ts';

/** The second visibility check of a provider frame, after its `load`. */
export const SURFACE_RECHECK_MS = 2_000;
/** How long a provider frame's `load` is awaited. */
export const SURFACE_LOAD_MS = 15_000;

/** Collaborators of {@link ChallengeWatch}. */
export interface ChallengeWatchDeps {
  readonly lookup: () => SitePackLookup | null;
  readonly navigations: AgentNavigations;
  readonly outcomes: { handle(detected: DetectedChallenge): Promise<void> };
  readonly clock: Clock;
  readonly logger: Logger;
}

/** True for a rule that only names a URL (decided at the commit, before the document loads). */
function urlOnly(rule: ChallengeRule): boolean {
  const m = rule.match;
  return (
    m.url !== undefined &&
    m.frame === undefined &&
    m.titles === undefined &&
    m.landmark === undefined &&
    m.text === undefined
  );
}

/** Watches pages of template hosts. */
export class ChallengeWatch {
  readonly #deps: ChallengeWatchDeps;
  readonly #log: Logger;

  constructor(deps: ChallengeWatchDeps) {
    this.#deps = deps;
    this.#log = deps.logger.child({ module: 'site-packs.watch' });
  }

  /** Starts watching a session's page (agent or maintenance; parked pages are not watched). */
  watch(templateId: string, page: Page, sessionId: string): void {
    try {
      new PageWatch(this.#deps, this.#log, templateId, page, sessionId).start();
    } catch (err) {
      this.#log.debug('page watch failed', { err: serializeError(err) });
    }
  }
}

/** The detection state of one page; reset at every main-frame commit. */
class PageWatch {
  #seq = 0;
  #exempt = false;
  #surfaces = new Set<ChallengeProvider>();
  #reported = new Set<string>();
  #chain: Promise<void> = Promise.resolve();

  constructor(
    private readonly deps: ChallengeWatchDeps,
    private readonly log: Logger,
    private readonly templateId: string,
    private readonly page: Page,
    private readonly sessionId: string,
  ) {}

  start(): void {
    this.page.on('framenavigated', (frame) => {
      if (frame === this.page.mainFrame()) this.#committed(frame.url());
      else this.#frame(frame);
    });
    this.page.on('domcontentloaded', () => this.#queue('dom', this.#seq));
    // A page adopted with a document already loaded (a site-opened page): read it once.
    if (hostOf(safeUrl(this.page)) !== null) this.#queue('dom', this.#seq);
  }

  #committed(url: string): void {
    this.#seq += 1;
    this.#surfaces = new Set();
    this.#reported = new Set();
    this.#exempt = this.deps.navigations.consume(this.page, this.sessionId, url);
    this.#queue('commit', this.#seq);
  }

  #frame(frame: Frame): void {
    const seq = this.#seq;
    const url = frame.url();
    const provider = providerOfFrameUrl(url);
    if (provider === null) return;
    if (isChallengePath(provider, url)) {
      this.#surface(provider, seq);
      return;
    }
    const check = () => this.#visibility(frame, provider, seq);
    void frame
      .waitForLoadState('load', { timeout: SURFACE_LOAD_MS })
      .then(check)
      .then(() => this.deps.clock.sleep(SURFACE_RECHECK_MS))
      .then(check)
      .catch(() => undefined);
  }

  async #visibility(frame: Frame, provider: ChallengeProvider, seq: number): Promise<void> {
    if (seq !== this.#seq || this.#surfaces.has(provider) || frame.isDetached()) return;
    const element = await frame.frameElement();
    try {
      const visible = await element.isVisible();
      const box = await element.boundingBox();
      if (isVisibleSurface(box, visible, this.page.viewportSize())) this.#surface(provider, seq);
    } finally {
      await element.dispose().catch(() => undefined);
    }
  }

  #surface(provider: ChallengeProvider, seq: number): void {
    if (seq !== this.#seq || this.#surfaces.has(provider)) return;
    this.#surfaces.add(provider);
    this.#queue('dom', seq);
  }

  #queue(phase: 'commit' | 'dom', seq: number): void {
    this.#chain = this.#chain
      .then(() => this.#evaluate(phase, seq))
      .catch((err: unknown) => {
        this.log.debug('challenge check failed', { err: serializeError(err) });
      });
  }

  async #evaluate(phase: 'commit' | 'dom', seq: number): Promise<void> {
    if (seq !== this.#seq || this.page.isClosed()) return;
    const url = safeUrl(this.page);
    const host = hostOf(url);
    if (host === null) return;
    const pack = this.deps.lookup()?.effectiveFor(host) ?? null;
    const all = challengeRulesFor(pack?.pack ?? null);
    const rules = phase === 'commit' ? all.filter(urlOnly) : all;
    if (rules.length === 0) return;
    const page = this.page;
    const facts: ChallengePageFacts = {
      url,
      urlExempt: this.#exempt,
      surfaces: new Set(this.#surfaces),
      title: () => page.title(),
      hasLandmark: async (selector) => (await page.locator(`css=${selector}`).count()) > 0,
      hasText: async (text) => (await page.getByText(text).count()) > 0,
    };
    const rule = await firstChallenge(rules, facts);
    if (rule === null || seq !== this.#seq) return;
    const key = `${rule.packId}#${rule.id}`;
    if (this.#reported.has(key)) return;
    this.#reported.add(key);
    await this.deps.outcomes.handle({
      templateId: this.templateId,
      sessionId: this.sessionId,
      pageUrl: url,
      rule,
    });
  }
}

function safeUrl(page: Page): string {
  try {
    return page.url();
  } catch {
    return 'about:blank';
  }
}
