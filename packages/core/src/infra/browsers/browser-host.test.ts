/** @module infra/browsers/browser-host.test — the exclusive host and its one view over a fake context: every page is the session's, listener order, crash and close, context-wide state, CDP scoping. */

import { describe, expect, it } from 'bun:test';
import type { Page } from 'playwright';
import { FakeClock } from '../../../test/helpers/fake-clock.ts';
import { asPage, FakePage } from '../../../test/helpers/fake-page.ts';
import { FakeBrowserContext } from '../../../test/helpers/fake-session-view.ts';
import { isAppError } from '../../kernel/errors/app-error.ts';
import { createCollectingLogger } from '../logging/collecting-logger.ts';
import { PlaywrightBrowserHost } from './browser-host.ts';
import { ExclusiveSessionView } from './session-view.ts';

const CAPABILITIES = {
  cdpScreencast: true,
  pdf: true,
  trace: true,
  closedShadowRoot: false,
  perContextProxy: true,
  isolatedEvaluate: false,
};

function launched(options: { before?: (context: FakeBrowserContext) => void } = {}) {
  const fake = new FakeBrowserContext();
  const first = fake.addPage();
  options.before?.(fake);
  const host = new PlaywrightBrowserHost({
    sessionId: 'shop-abcd1234',
    browser: null,
    context: fake.context,
    capabilities: CAPABILITIES,
    driver: 'playwright',
    identity: null,
    browserInfo: { version: null, sandboxed: false },
    warnings: [],
    tracing: null,
    applier: null,
    clock: new FakeClock(),
    logger: createCollectingLogger(),
  });
  const view = new ExclusiveSessionView(host, asPage(first), '/data/sessions/shop/userdata');
  return { fake, host, view, first: asPage(first) };
}

describe('the exclusive host and its view', () => {
  it('is named after its session and owns the first page', () => {
    const { host, view, first } = launched();
    expect(host.hostId).toBe('shop-abcd1234');
    expect(host.kind).toBe('exclusive');
    expect(view.sessionId).toBe('shop-abcd1234');
    expect(view.host).toBe(host);
    expect(view.page).toBe(first);
    expect(view.pages()).toEqual([first]);
    expect(view.owns(first)).toBe(true);
  });

  it('gives every later page to the session, after the listeners that came first', async () => {
    const order: string[] = [];
    const { fake, view } = launched({
      // The identity applier subscribes during launch, before the host exists.
      before: (context) => context.on('page', () => order.push('applier')),
    });
    view.onPage(() => order.push('view'));
    const tab = await view.newPage();
    const popup = asPage(fake.openPopup('https://popup.example/'));
    expect(order).toEqual(['applier', 'view', 'applier', 'view']);
    expect(view.pages()).toEqual([view.page, tab, popup]);
    expect(view.owns(popup)).toBe(true);
  });

  it('a closed page leaves pages() and owns()', async () => {
    const { fake, view } = launched();
    const popup = fake.openPopup();
    await popup.close();
    expect(view.pages()).toEqual([view.page]);
    expect(view.owns(asPage(popup))).toBe(false);
  });

  it('refuses a CDP session on a page it was never given', async () => {
    const { view } = launched();
    const stranger: Page = asPage(new FakePage());
    const error = await view.newCDPSession(stranger).then(
      () => null,
      (err: unknown) => err,
    );
    expect(isAppError(error) && error.code).toBe('INTERNAL_ERROR');
  });

  it('reads and writes cookies, extra headers and the storage state on the context', async () => {
    const { fake, view } = launched();
    const calls: unknown[] = [];
    Object.assign(fake, {
      cookies: async (urls?: unknown) => {
        calls.push(['cookies', urls]);
        return [];
      },
      addCookies: async (cookies: unknown) => {
        calls.push(['addCookies', cookies]);
      },
      setExtraHTTPHeaders: async (headers: unknown) => {
        calls.push(['headers', headers]);
      },
    });
    await view.cookies();
    await view.cookies(['https://a.example/']);
    await view.addCookies([{ name: 'n', value: 'v', url: 'https://a.example/' }]);
    await view.setExtraHTTPHeaders({ 'x-a': '1' });
    expect(calls).toEqual([
      ['cookies', undefined],
      ['cookies', ['https://a.example/']],
      ['addCookies', [{ name: 'n', value: 'v', url: 'https://a.example/' }]],
      ['headers', { 'x-a': '1' }],
    ]);
    expect(view.storageStateSource()).toBe(view.host.context);
    expect(view.userDataDir()).toBe('/data/sessions/shop/userdata');
  });

  it('a context that closes on its own is a crash; an orderly close is not', async () => {
    const crashed = launched();
    const reasons: string[] = [];
    crashed.view.onCrash((reason) => reasons.push(reason));
    await crashed.fake.close();
    expect(reasons).toEqual(['context closed']);

    const closed = launched();
    const none: string[] = [];
    closed.view.onCrash((reason) => none.push(reason));
    expect(await closed.view.close(1_000)).toEqual([]);
    expect(closed.fake.closed).toBe(true);
    expect(none).toEqual([]);
  });
});
