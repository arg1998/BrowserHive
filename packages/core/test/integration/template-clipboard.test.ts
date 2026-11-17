/// <reference lib="dom" />
/** @module test/integration/template-clipboard.test — "Deny clipboard writes" on a real template host (spec 13 §2.1, §13 "The operator's desktop"; D18), template stealth off and standard: with the switch off a page's `navigator.clipboard` writes and `execCommand('copy')` after a real click reach the clipboard, and its `copy` listener rewrites a person's own Ctrl/Cmd+C; with it on (at host start, or applied live without a restart) every one of those is refused, the clipboard keeps what the operator put there and a person's copy is what they selected; turning it off live lifts the permission at once and the rest at the next load. */

import { afterEach, describe, expect, it } from 'bun:test';
import type { CDPSession, Page } from 'patchright';
import type { Session } from '../../src/domain/session/session.ts';
import { applyClipboardPolicy } from '../../src/infra/browsers/clipboard-policy.ts';
import { createCollectingLogger } from '../../src/infra/logging/collecting-logger.ts';
import { STEALTH_LEGS, type TemplateWorld, templateWorld } from './template-fixture.ts';

const READER = 'https://site-b.test';
const logger = createCollectingLogger();

let world: TemplateWorld | null = null;
afterEach(async () => {
  await world?.stop();
  world = null;
});

function pageOf(session: Session): Page {
  const view = session.view;
  if (view === null) throw new Error(`${session.id} has no view`);
  return view.page;
}

/**
 * The clipboard as the operator sees it: read (and seeded) by a page on another site that may. The
 * grants live on a browser session kept open (Chromium drops a session's overrides when it
 * detaches) and are renewed per call: lifting the denial resets every override of the context.
 */
class ClipboardReader {
  constructor(
    private readonly cdp: CDPSession,
    private readonly reader: Page,
  ) {}

  async #grant(name: 'clipboard-read' | 'clipboard-write'): Promise<void> {
    await this.cdp.send('Browser.setPermission', {
      permission: { name },
      setting: 'granted',
      origin: READER,
    });
  }

  async read(back: Page): Promise<string> {
    await this.#grant('clipboard-read');
    await this.reader.bringToFront();
    const text = await this.reader.evaluate(() => navigator.clipboard.readText());
    await back.bringToFront();
    return text;
  }

  /** Puts `text` on the clipboard from the reader's site (the operator's own content). */
  async seed(text: string, back: Page): Promise<void> {
    await this.#grant('clipboard-write');
    await this.reader.bringToFront();
    await this.reader.evaluate((value) => navigator.clipboard.writeText(value), text);
    await back.bringToFront();
  }
}

/** Opens the clipboard page in one session and a reader page in another. */
async function setUp(w: TemplateWorld): Promise<{ page: Page; clipboard: ClipboardReader }> {
  const reader = pageOf(await w.launch('reader'));
  await reader.goto(`${READER}/landing`);
  const page = pageOf(await w.launch('agent'));
  await page.goto(w.sites.url('site-a.test', '/clipboard'));
  const browser = w.host().context.browser();
  if (browser === null) throw new Error('no browser');
  const cdp = await browser.newBrowserCDPSession();
  return { page, clipboard: new ClipboardReader(cdp, reader) };
}

/** Clicks a fixture button (a real click: user activation) and returns the outcome it reports. */
async function press(page: Page, id: string): Promise<string> {
  await page.click(`#${id}`);
  await page.waitForFunction((prefix) => document.title.startsWith(prefix), `${id}:`);
  return (await page.title()).slice(id.length + 1);
}

function permissionState(page: Page): Promise<string> {
  return page.evaluate(() =>
    navigator.permissions.query({ name: 'clipboard-write' as PermissionName }).then((s) => s.state),
  );
}

async function expectAllowed(page: Page, clipboard: ClipboardReader): Promise<void> {
  expect(await press(page, 'write-text')).toBe('ok');
  expect(await clipboard.read(page)).toBe('planted-by-writeText');
  expect(await press(page, 'write-item')).toBe('ok');
  expect(await clipboard.read(page)).toBe('planted-by-write');
  expect(await press(page, 'exec-copy')).toBe('true');
  expect(await clipboard.read(page)).toBe('planted-by-copy');
  // Without the switch a page's `copy` listener rewrites a person's own Ctrl/Cmd+C.
  expect(await press(page, 'hijack')).toBe('armed');
  expect(await press(page, 'select-all')).toBe('true');
  await page.keyboard.press('ControlOrMeta+C');
  expect(await clipboard.read(page)).toBe('planted-by-hijack');
}

async function expectDenied(page: Page, clipboard: ClipboardReader): Promise<void> {
  await clipboard.seed('operator text', page);
  expect(await press(page, 'write-text')).toBe('NotAllowedError');
  expect(await press(page, 'write-item')).toBe('NotAllowedError');
  expect(await press(page, 'exec-copy')).toBe('false');
  expect(await press(page, 'exec-cut')).toBe('false');
  // A pristine `execCommand` from a fresh frame's realm is patched too.
  expect(await press(page, 'iframe-copy')).toBe('false');
  expect(await clipboard.read(page)).toBe('operator text');
  expect(await permissionState(page)).toBe('denied');
  // Other editing commands are untouched.
  expect(await press(page, 'select-all')).toBe('true');
  // A person's own copy still works, and the page cannot rewrite it.
  expect(await press(page, 'hijack')).toBe('armed');
  expect(await press(page, 'select-all')).toBe('true');
  await page.keyboard.press('ControlOrMeta+C');
  expect(await clipboard.read(page)).toBe('field text');
}

for (const stealth of STEALTH_LEGS) {
  describe(`deny clipboard writes (stealth ${stealth})`, () => {
    it('off (the default): a page can write the clipboard after a real click', async () => {
      world = await templateWorld(stealth);
      const { page, clipboard } = await setUp(world);
      await expectAllowed(page, clipboard);
    });

    it('on at host start: every way a page writes the clipboard is refused', async () => {
      world = await templateWorld(stealth, { template: { denyClipboardWrites: true } });
      const { page, clipboard } = await setUp(world);
      await expectDenied(page, clipboard);
      // A document loaded afterwards, in a new tab, is covered from its first script.
      await page.reload();
      await expectDenied(page, clipboard);
    });

    it('applies live without a restart, both ways', async () => {
      world = await templateWorld(stealth);
      const { page, clipboard } = await setUp(world);
      const host = world.host();
      await applyClipboardPolicy(host.context, true, logger);
      // The open document, not reloaded.
      await expectDenied(page, clipboard);
      expect(world.hosts).toHaveLength(1);

      await applyClipboardPolicy(host.context, false, logger);
      expect(await press(page, 'write-text')).toBe('ok');
      expect(await clipboard.read(page)).toBe('planted-by-writeText');
      // The open document keeps the `execCommand` patch until it reloads; then it is gone.
      expect(await press(page, 'exec-copy')).toBe('false');
      await page.reload();
      await expectAllowed(page, clipboard);
      expect(world.hosts).toHaveLength(1);
    });
  });
}
