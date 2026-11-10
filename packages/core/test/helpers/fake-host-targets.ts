/** @module test/helpers/fake-host-targets — a template host over fakes: a `FakeBrowserContext` whose pages carry scripted target facts, and a `HostTargets` stand-in whose windows appear as `page` events (before or after `createTarget` answers). */

import type { Page } from 'playwright';
import { InterceptionChain } from '../../src/infra/browsers/interception-chain.ts';
import type { TargetFacts } from '../../src/infra/browsers/page-attribution.ts';
import { PlaywrightTemplateHost } from '../../src/infra/browsers/template-host.ts';
import type { HostTargets, WindowRequest } from '../../src/infra/browsers/template-targets.ts';
import { createCollectingLogger } from '../../src/infra/logging/collecting-logger.ts';
import { FakeClock } from './fake-clock.ts';
import { asPage, type FakePage } from './fake-page.ts';
import { FakeBrowserContext } from './fake-session-view.ts';

/** A scripted DevTools session (`send` answers by method). */
export class FakeCdp {
  readonly sent: string[] = [];
  answers: Record<string, unknown> = {};
  async send(method: string): Promise<unknown> {
    this.sent.push(method);
    return this.answers[method] ?? {};
  }
  on(): this {
    return this;
  }
  async detach(): Promise<void> {
    return;
  }
}

/** A context whose `newCDPSession` hands out {@link FakeCdp}s. */
export class FakeHostContext extends FakeBrowserContext {
  readonly cdps: FakeCdp[] = [];
  cdpAnswers: Record<string, unknown> = {};
  async newCDPSession(): Promise<FakeCdp> {
    const cdp = new FakeCdp();
    cdp.answers = { ...this.cdpAnswers };
    this.cdps.push(cdp);
    return cdp;
  }
  async cookies(): Promise<unknown[]> {
    return [];
  }
}

/** Windows and facts of the fake host. */
export class FakeTargets {
  readonly facts = new Map<Page, TargetFacts>();
  readonly created: WindowRequest[] = [];
  readonly closedTargets: string[] = [];
  /** `adoptFirst`: the page event fires before `createTarget` answers. */
  timing: 'claimFirst' | 'adoptFirst' = 'claimFirst';
  lost: ((facts: TargetFacts) => void) | null = null;
  destroyed: ((targetId: string) => void) | null = null;
  private next = 0;

  constructor(private readonly context: FakeHostContext) {}

  /** A page that exists with the given facts; `emit` fires the context's `page` event. */
  page(targetId: string, openerId: string | null = null, emit = true): FakePage {
    const fake = this.context.addPage();
    this.facts.set(asPage(fake), { targetId, openerId });
    if (emit) this.context.emit('page', asPage(fake));
    return fake;
  }

  factsOf(page: Page): TargetFacts {
    const read = this.facts.get(page);
    if (read === undefined) throw new Error('no facts');
    return read;
  }

  async createWindow(request: WindowRequest): Promise<string> {
    this.created.push(request);
    const targetId = `W${this.next++}`;
    if (this.timing === 'adoptFirst') {
      this.page(targetId);
      return targetId;
    }
    setTimeout(() => this.page(targetId), 0);
    return targetId;
  }

  async closeTarget(targetId: string): Promise<void> {
    this.closedTargets.push(targetId);
  }
  async minimize(): Promise<void> {
    return;
  }
  async resize(): Promise<void> {
    return;
  }
  async watchNewTabs(): Promise<void> {
    return;
  }
  async dispose(): Promise<void> {
    return;
  }
  onLostTarget(listener: (facts: TargetFacts) => void): void {
    this.lost = listener;
  }
  onDestroyed(listener: (targetId: string) => void): void {
    this.destroyed = listener;
  }
}

/** A `PlaywrightTemplateHost` over the fakes. */
export function fakeTemplateHost(options: { readonly startPages?: number } = {}) {
  const context = new FakeHostContext();
  const targets = new FakeTargets(context);
  for (let i = 0; i < (options.startPages ?? 1); i++) targets.page(`S${i}`, null, false);
  const logger = createCollectingLogger();
  const clock = new FakeClock();
  const host = new PlaywrightTemplateHost({
    templateId: 'tp-fake',
    context: context.context,
    targets: targets as unknown as HostTargets,
    chain: new InterceptionChain({ resolveOwner: async () => ({ kind: 'host' }), logger }),
    capabilities: {
      cdpScreencast: true,
      pdf: true,
      trace: false,
      closedShadowRoot: false,
      perContextProxy: true,
      isolatedEvaluate: false,
    },
    driver: 'playwright',
    browserInfo: { version: null, sandboxed: false },
    warnings: [],
    headless: true,
    window: { width: 800, height: 600 },
    clock,
    logger,
  });
  return { host, context, targets, clock };
}
