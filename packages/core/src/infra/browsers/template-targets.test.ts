/** @module infra/browsers/template-targets.test — browser-level discovery of a template host: openers from discovery, targets lost before their page was read, and openers of modifier-click tabs (PR #76 F6, F9). */

import { describe, expect, it } from 'bun:test';
import type { BrowserContext, CDPSession, Page } from 'playwright';
import { createCollectingLogger } from '../logging/collecting-logger.ts';
import { NewTabRequests } from './new-tab-requests.ts';
import type { TargetFacts } from './page-attribution.ts';
import { HostTargets } from './template-targets.ts';

type Handler = (payload: never) => void;

/** A browser-level session whose events the test emits. */
class FakeBrowserCdp {
  private readonly handlers = new Map<string, Handler[]>();
  on(event: string, handler: Handler): this {
    this.handlers.set(event, [...(this.handlers.get(event) ?? []), handler]);
    return this;
  }
  emit(event: string, payload: unknown): void {
    for (const handler of this.handlers.get(event) ?? []) handler(payload as never);
  }
  async send(): Promise<object> {
    return {};
  }
  async detach(): Promise<void> {
    return;
  }
}

const page = (id: string, openerId?: string) => ({
  targetInfo: {
    targetId: id,
    type: 'page',
    browserContextId: 'C',
    url: '',
    ...(openerId && { openerId }),
  },
});

/** A context whose page sessions answer `Target.getTargetInfo` without an opener. */
function contextFor(targetIdOf: Map<Page, string>): BrowserContext {
  return {
    newCDPSession: async (p: Page) => ({
      send: async () => ({ targetInfo: { targetId: targetIdOf.get(p), type: 'page' } }),
      detach: async () => undefined,
    }),
  } as unknown as BrowserContext;
}

async function attach(targetIdOf = new Map<Page, string>()) {
  const cdp = new FakeBrowserCdp();
  const targets = await HostTargets.attach(
    cdp as unknown as CDPSession,
    contextFor(targetIdOf),
    'C',
    createCollectingLogger(),
  );
  return { cdp, targets, targetIdOf };
}

describe('HostTargets', () => {
  it('reports a target destroyed before any page of it was read, with its real opener', async () => {
    const { cdp, targets } = await attach();
    const lost: TargetFacts[] = [];
    targets.onLostTarget((facts) => lost.push(facts));
    cdp.emit('Target.targetCreated', page('P', 'S1'));
    cdp.emit('Target.targetDestroyed', { targetId: 'P' });
    await Promise.resolve();
    expect(lost).toEqual([{ targetId: 'P', openerId: 'S1' }]);
  });

  it('a target whose page was read is not lost', async () => {
    const p = {} as Page;
    const { cdp, targets } = await attach(new Map([[p, 'P']]));
    const lost: TargetFacts[] = [];
    targets.onLostTarget((facts) => lost.push(facts));
    cdp.emit('Target.targetCreated', page('P', 'S1'));
    await targets.factsOf(p);
    cdp.emit('Target.targetDestroyed', { targetId: 'P' });
    await Promise.resolve();
    expect(lost).toEqual([]);
  });

  it('takes the opener from discovery when the page session does not name one', async () => {
    const p = {} as Page;
    const { cdp, targets } = await attach(new Map([[p, 'P']]));
    cdp.emit('Target.targetCreated', page('P', 'S1'));
    expect(await targets.factsOf(p)).toEqual({ targetId: 'P', openerId: 'S1' });
  });

  it('gives a modifier-click tab the opener that requested its URL', async () => {
    const p = {} as Page;
    const { cdp, targets } = await attach(new Map([[p, 'T']]));
    targets.newTabs.requested('S1', 'https://site-b.test/x');
    cdp.emit('Target.targetCreated', page('T'));
    cdp.emit('Target.targetInfoChanged', {
      targetInfo: { ...page('T').targetInfo, url: 'https://site-b.test/x' },
    });
    expect(await targets.factsOf(p)).toEqual({ targetId: 'T', openerId: 'S1' });
  });
});

describe('NewTabRequests', () => {
  it('refuses to guess when two pages requested the same URL, and forgets stale requests', async () => {
    let now = 0;
    const requests = new NewTabRequests(() => now);
    requests.requested('A', 'https://x.test/');
    requests.requested('B', 'https://x.test/');
    requests.urlOf('T', 'https://x.test/');
    expect(await requests.openerOf('T', 0)).toBeNull();
    now = 10_000;
    requests.requested('A', 'https://y.test/');
    requests.urlOf('U', 'https://y.test/');
    expect(await requests.openerOf('U', 0)).toBe('A');
    expect(await requests.openerOf('U', 0)).toBeNull();
  });

  it('waits briefly for a URL that arrives after the target', async () => {
    const requests = new NewTabRequests(() => 0);
    requests.requested('A', 'https://z.test/');
    const pending = requests.openerOf('V', 500);
    requests.urlOf('V', 'https://z.test/');
    expect(await pending).toBe('A');
  });
});
