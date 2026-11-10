/** @module app/sessions/scheme-guard.test — the non-web scheme backstop on FakePage: main-frame commits only, tab removed, page closed, logged. */

import { describe, expect, it } from 'bun:test';
import { FakePage } from '../../../test/helpers/fake-page.ts';
import { createCollectingLogger } from '../../../test/helpers/test-logger.ts';
import { TabRegistry } from '../../domain/session/tabs.ts';
import { guardPageScheme } from './scheme-guard.ts';

function frame(url: string, main = true): { url(): string; parentFrame(): unknown } {
  return { url: () => url, parentFrame: () => (main ? null : {}) };
}

function setup(url = 'about:blank', allowData = true) {
  let n = 0;
  const tabs = new TabRegistry('s-1', () => `t-${++n}`);
  const logger = createCollectingLogger();
  const fake = new FakePage(url);
  const tabId = tabs.add(fake.page);
  guardPageScheme(fake.page, {
    sessionId: 's-1',
    tabs,
    logger,
    allowData,
    newCDPSession: () => Promise.reject(new Error('no CDP in unit tests')),
  });
  return { tabs, logger, fake, tabId };
}

async function settle(fake: FakePage): Promise<void> {
  for (let i = 0; i < 20 && !fake.isClosed(); i++) await Bun.sleep(5);
}

describe('guardPageScheme', () => {
  it('closes the page and removes its tab when the main frame commits file:', async () => {
    const { tabs, logger, fake, tabId } = setup();
    fake.emit('framenavigated', frame('file:///etc/hosts'));
    expect(tabs.has(tabId)).toBe(false);
    await settle(fake);
    expect(fake.isClosed()).toBe(true);
    expect(logger.find('non-web scheme page closed').at(0)?.fields).toEqual({
      sessionId: 's-1',
      tabId,
      scheme: 'file',
    });
  });

  it('ignores subframe commits and web, blob, data, about:blank/srcdoc and chrome-error commits', async () => {
    const { tabs, logger, fake, tabId } = setup();
    fake.emit('framenavigated', frame('file:///etc/hosts', false));
    for (const url of [
      'https://example.com/',
      'blob:https://example.com/00000000-0000-0000-0000-000000000000',
      'data:text/html,x',
      'about:blank',
      'about:srcdoc',
      'chrome-error://chromewebdata/',
    ]) {
      fake.emit('framenavigated', frame(url));
    }
    await Bun.sleep(20);
    expect(fake.isClosed()).toBe(false);
    expect(tabs.has(tabId)).toBe(true);
    expect(logger.has('non-web scheme page closed')).toBe(false);
  });

  it('closes a page that already shows a non-web URL when the guard attaches', async () => {
    const { tabs, fake, tabId } = setup('chrome://version/');
    expect(tabs.has(tabId)).toBe(false);
    await settle(fake);
    expect(fake.isClosed()).toBe(true);
  });

  it('closes once, however many commits follow', async () => {
    const { logger, fake } = setup();
    fake.emit('framenavigated', frame('file:///a'));
    fake.emit('framenavigated', frame('view-source:file:///a'));
    await settle(fake);
    expect(logger.find('non-web scheme page closed')).toHaveLength(1);
    expect(fake.methods().filter((m) => m === 'close')).toHaveLength(1);
  });

  it('closes a data: commit in a template session, where data: is not a web scheme (spec 13 §5.5)', async () => {
    const { tabs, logger, fake, tabId } = setup('about:blank', false);
    fake.emit('framenavigated', frame('data:text/html,<p>x</p>'));
    expect(tabs.has(tabId)).toBe(false);
    await settle(fake);
    expect(fake.isClosed()).toBe(true);
    expect(logger.find('non-web scheme page closed').at(0)?.fields).toMatchObject({
      scheme: 'data',
    });
  });
});
