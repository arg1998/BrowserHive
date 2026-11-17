/** @module test/helpers/site-actions-kit — a `SiteActionStrategies` world for unit tests (spec 13 §9.4): scripted sessions and pages, one pack on `site-a.test` whose strategies a test chooses, a fake clock, injected random and a recording focus control. */

import { SitePackV1, type SitePackV1Input } from '@browserhive/contracts/site-packs';
import { SiteActionStrategies } from '../../src/app/site-packs/strategies/site-actions.ts';
import type { Session } from '../../src/domain/session/session.ts';
import type { PageFocusControl } from '../../src/ports/page-focus.ts';
import type { Page } from '../../src/ports/page-types.ts';
import type { EffectivePack, SitePackLookup } from '../../src/ports/site-packs.ts';
import { templateSiteRecord } from '../persistence/helpers.ts';
import { CollectingLogger } from './collecting-logger.ts';
import { FakeClock } from './fake-clock.ts';
import { sitePack } from './site-pack-kit.ts';

export const SITE = 'site-a.test';

/** A page double: its URL, the warm-up's route and `goto` calls. */
export class StrategyPage {
  closed = false;
  readonly gotos: { url: string; referer: string | undefined; timeout: number | undefined }[] = [];
  routes = 0;
  /** Set to make the next `goto` reject. */
  failNext: Error | null = null;
  constructor(public href = 'about:blank') {}
  url(): string {
    return this.href;
  }
  isClosed(): boolean {
    return this.closed;
  }
  mainFrame(): object {
    return this;
  }
  async route(): Promise<void> {
    this.routes += 1;
  }
  async unroute(): Promise<void> {
    this.routes -= 1;
  }
  async evaluate(): Promise<null> {
    return null;
  }
  async goto(url: string, options: { referer?: string; timeout?: number } = {}): Promise<null> {
    this.gotos.push({ url, referer: options.referer, timeout: options.timeout });
    if (this.failNext !== null) {
      const err = this.failNext;
      this.failNext = null;
      throw err;
    }
    this.href = url;
    return null;
  }
}

/** A focus control recording which pages are unfocused. */
export class RecordingFocus implements PageFocusControl {
  readonly off = new Set<Page>();
  async setEmulated(page: Page, emulated: boolean, headless: boolean): Promise<void> {
    this.headless.push(headless);
    if (emulated) this.off.delete(page);
    else this.off.add(page);
  }
  isUnfocused(page: Page): boolean {
    return this.off.has(page);
  }
  readonly headless: boolean[] = [];
}

export const asPage = (p: StrategyPage): Page => p as unknown as Page;

/** A scripted session: `live` (agent), `maintenance` or exclusive (`null`). */
export function scriptedSession(
  id: string,
  mode: 'live' | 'maintenance' | null = 'live',
  options: { stealth?: boolean; humanize?: boolean; headless?: boolean; templateId?: string } = {},
): Session {
  const template =
    mode === null
      ? null
      : { templateId: options.templateId ?? 'tp-1', name: 'job-hunt', mode, sealed: false };
  return {
    id,
    template,
    request: {
      stealth: options.stealth ?? true,
      humanize: options.humanize ?? false,
      headless: options.headless ?? true,
    },
  } as unknown as Session;
}

/** The strategies world. */
export interface StrategiesWorld {
  readonly runner: SiteActionStrategies;
  readonly clock: FakeClock;
  readonly logger: CollectingLogger;
  readonly focus: RecordingFocus;
  readonly expected: { page: object; url: string }[];
  /** Session id → its pages (the first is the active one). */
  readonly pages: Map<string, StrategyPage[]>;
  readonly sessions: Session[];
  lookupOn: boolean;
  add(session: Session, ...pages: StrategyPage[]): Session;
}

/** A world whose `site-a.test` pack selects `strategies`. */
export function strategiesWorld(
  strategies: SitePackV1Input['strategies'],
  options: { random?: () => number; serializeWaitMs?: number } = {},
): StrategiesWorld {
  const pack = SitePackV1.parse(sitePack(SITE, 1, { strategies }));
  const effective: EffectivePack = {
    packId: SITE,
    pack,
    version: 1,
    sha256: 'c'.repeat(64),
    source: 'bundled',
    localOverride: false,
  };
  const lookup: SitePackLookup = {
    effectiveFor: (host) => (host === SITE || host.endsWith(`.${SITE}`) ? effective : null),
    effectiveById: (id) => (id === SITE ? effective : null),
    generation: 1,
  };
  const clock = new FakeClock();
  const logger = new CollectingLogger();
  const focus = new RecordingFocus();
  const pages = new Map<string, StrategyPage[]>();
  const sessions: Session[] = [];
  const expected: { page: object; url: string }[] = [];
  const pagesOf = (s: Session) => (pages.get(s.id) ?? []).map(asPage);
  const world: StrategiesWorld = {
    clock,
    logger,
    focus,
    expected,
    pages,
    sessions,
    lookupOn: true,
    add(session, ...list) {
      sessions.push(session);
      pages.set(session.id, list);
      return session;
    },
    runner: new SiteActionStrategies({
      lookup: () => (world.lookupOn ? lookup : null),
      sites: async (templateId) => [templateSiteRecord({ templateId, siteId: SITE })],
      pageOf: (s, tabId) => {
        const list = pagesOf(s);
        const page = tabId === undefined ? list[0] : list[Number(tabId)];
        if (page === undefined) throw new Error('TAB_NOT_FOUND');
        return page;
      },
      pagesOf,
      sessions: () => sessions,
      focus,
      navigations: { expectOnPage: (page, url) => expected.push({ page, url }) },
      clock,
      random: options.random ?? (() => 0),
      logger,
      ...(options.serializeWaitMs !== undefined && { serializeWaitMs: options.serializeWaitMs }),
    }),
  };
  return world;
}

/** Lets pending promise continuations run (one macrotask). */
export async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}
