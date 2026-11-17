/// <reference lib="dom" />
/** @module test/integration/template-clipboard.test — "Deny clipboard writes" on a real template host (spec 13 §2.1, §13 "The operator's desktop"; D18), template stealth off and standard: with the switch off a page's `navigator.clipboard` writes and `execCommand('copy')` after a real click reach the clipboard, from any frame, and its `copy` listener rewrites a person's own Ctrl/Cmd+C; with it on at host start every one of those is refused, including the bypasses of review #84 (a `toString` that answers twice, built-ins replaced to steal the native method, a trap on `Object.prototype`, other realms: frames loaded with the page, sandboxed, cross-site out-of-process frames, a popup), the clipboard keeps what the operator put there and a person's copy is what they selected; applied live it reaches every frame of the open page at once, and only a reference taken before the change survives until the document reloads (the host then says a restart gives full effect); turning it off live lifts the permission at once and the rest at the next load; a change while the browser starts is applied once it runs. */

import { afterEach, describe, expect, it } from 'bun:test';
import type { CDPSession, Frame, Page } from 'patchright';
import { watchClipboardOnStart } from '../../src/app/templates/clipboard-switch.ts';
import type { Session } from '../../src/domain/session/session.ts';
import {
  applyClipboardPolicy,
  clipboardNeedsRestart,
} from '../../src/infra/browsers/clipboard-policy.ts';
import { createCollectingLogger } from '../../src/infra/logging/collecting-logger.ts';
import { STEALTH_LEGS, type TemplateWorld, templateWorld, until } from './template-fixture.ts';

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
async function setUp(
  w: TemplateWorld,
  agent?: Session,
): Promise<{ page: Page; clipboard: ClipboardReader }> {
  const reader = pageOf(await w.launch('reader'));
  await reader.goto(`${READER}/landing`);
  const page = pageOf(agent ?? (await w.launch('agent')));
  await page.goto(w.sites.url('site-a.test', '/clipboard'));
  const browser = w.host().context.browser();
  if (browser === null) throw new Error('no browser');
  const cdp = await browser.newBrowserCDPSession();
  return { page, clipboard: new ClipboardReader(cdp, reader) };
}

/**
 * Clicks a fixture button (a real click: user activation) in a page or one of its frames and
 * returns the outcome it reports in that document's title.
 */
async function press(target: Page | Frame, id: string): Promise<string> {
  await target.click(`#${id}`);
  await target.waitForFunction((prefix) => document.title.startsWith(prefix), `${id}:`);
  return (await target.title()).slice(id.length + 1);
}

/** The page's frame loaded from `host` (`sub.site-a.test`: same site; `cdn-a.test`: cross-site). */
function frameOf(page: Page, host: string): Frame {
  const frame = page.frames().find((f) => new URL(f.url()).host === host);
  if (frame === undefined) throw new Error(`no frame from ${host}`);
  return frame;
}

/** The frames loaded with the page, as `[host, frame]`. */
function framesOf(page: Page): [string, Frame][] {
  return ['sub.site-a.test', 'cdn-a.test'].map((host) => [host, frameOf(page, host)]);
}

function permissionState(page: Page): Promise<string> {
  return page.evaluate(() =>
    navigator.permissions.query({ name: 'clipboard-write' as PermissionName }).then((s) => s.state),
  );
}

async function expectAllowed(
  page: Page,
  clipboard: ClipboardReader,
  hosts: readonly string[] = ['sub.site-a.test', 'cdn-a.test'],
): Promise<void> {
  expect(await press(page, 'write-text')).toBe('ok');
  expect(await clipboard.read(page)).toBe('planted-by-writeText');
  expect(await press(page, 'write-item')).toBe('ok');
  expect(await clipboard.read(page)).toBe('planted-by-write');
  expect(await press(page, 'exec-copy')).toBe('true');
  expect(await clipboard.read(page)).toBe('planted-by-copy');
  // The frames' and other realms' copies reach the clipboard too (each test below needs them).
  expect(await press(page, 'pre-iframe-copy')).toBe('true');
  expect(await clipboard.read(page)).toBe('planted-by-pre-iframe');
  for (const host of hosts) {
    expect(await press(frameOf(page, host), 'frame-copy')).toBe('true');
    expect(await clipboard.read(page)).toBe(`planted-by-frame-${host}`);
  }
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

/**
 * The bypasses of review #84 and their variants, each refused with the operator's text kept: H1
 * (a command whose `toString` answers `bold`, then `copy`; `selectAll`, then `cut`, through
 * `Reflect.apply`), other spellings and call forms, the native method stolen through a replaced
 * `Reflect.apply` or an `Object.prototype.get` trap, replaced `toLowerCase` and `String`, every
 * other realm (frames loaded with the page — the M2 PoC —, `srcdoc`, sandboxed, a popup, the
 * same-site and the cross-site out-of-process frame and the frames inside them), clipboard API
 * calls with lying arguments, and a page that disarms the copy-listener stopper.
 */
async function expectBypassesRefused(page: Page, clipboard: ClipboardReader): Promise<void> {
  const refused: [string, string][] = [
    ['toctou-copy', 'false'],
    ['toctou-cut', 'true'],
    ['case-copy', 'false,false,false'],
    ['call-copy', 'false,false,false'],
    ['reflect-steal-copy', 'false'],
    ['trap-steal-copy', 'false'],
    ['lower-copy', 'false'],
    ['string-copy', 'false'],
    ['pre-iframe-copy', 'false'],
    ['srcdoc-copy', 'false'],
    ['sandbox-copy', 'false'],
    ['lying-write-text', 'NotAllowedError'],
    ['proxy-write', 'NotAllowedError'],
  ];
  await clipboard.seed('operator text', page);
  for (const [id, outcome] of refused) {
    expect([id, await press(page, id)]).toEqual([id, outcome]);
  }
  for (const [host, frame] of framesOf(page)) {
    expect([host, await press(frame, 'frame-copy')]).toEqual([host, 'false']);
    expect([host, await press(frame, 'nested-copy')]).toEqual([host, 'false']);
  }
  expect(await press(page, 'popup-open')).toBe('opened');
  expect(await press(page, 'popup-copy')).toBe('false');
  expect(await clipboard.read(page)).toBe('operator text');
  // Last: the page keeps its replaced `stopImmediatePropagation` and its listener.
  expect(await press(page, 'stop-override')).toBe('armed');
  expect(await press(page, 'select-all')).toBe('true');
  await page.keyboard.press('ControlOrMeta+C');
  expect(await clipboard.read(page)).toBe('field text');
}

/** A reference to the method taken by the page's first script (before any live change). */
async function savedCopy(page: Page, clipboard: ClipboardReader): Promise<[string, string]> {
  await clipboard.seed('operator text', page);
  const outcome = await press(page, 'saved-copy');
  return [outcome, await clipboard.read(page)];
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
      expect(await savedCopy(page, clipboard)).toEqual(['false', 'operator text']);
      expect(clipboardNeedsRestart(world.host().context)).toBe(false);
      // A document loaded afterwards, in a new tab, is covered from its first script.
      await page.reload();
      await expectDenied(page, clipboard);
    });

    it('on at host start: the bypasses of review #84 are refused', async () => {
      world = await templateWorld(stealth, { template: { denyClipboardWrites: true } });
      const { page, clipboard } = await setUp(world);
      await expectBypassesRefused(page, clipboard);
    });

    it('applied live: every frame of the open page at once; a restart gives full effect', async () => {
      world = await templateWorld(stealth);
      const { page, clipboard } = await setUp(world);
      const host = world.host();
      await applyClipboardPolicy(host.context, true, logger);
      // The open document and every frame in it, not reloaded (review #84 M2).
      await expectBypassesRefused(page, clipboard);
      // What no live change can reach: a reference the page took before it. The host says so.
      expect(await savedCopy(page, clipboard)).toEqual(['true', 'planted-by-saved']);
      expect(clipboardNeedsRestart(host.context)).toBe(true);
      // A document loaded afterwards is fully covered.
      await page.reload();
      expect(await savedCopy(page, clipboard)).toEqual(['false', 'operator text']);
      expect(world.hosts).toHaveLength(1);
    });

    it('applies live without a restart, both ways', async () => {
      world = await templateWorld(stealth);
      const { page, clipboard } = await setUp(world);
      const host = world.host();
      await applyClipboardPolicy(host.context, true, logger);
      await expectDenied(page, clipboard);
      expect(world.hosts).toHaveLength(1);

      await applyClipboardPolicy(host.context, false, logger);
      expect(await press(page, 'write-text')).toBe('ok');
      expect(await clipboard.read(page)).toBe('planted-by-writeText');
      // The open document, its frames included, keeps the `execCommand` patch until it reloads.
      expect(await press(page, 'exec-copy')).toBe('false');
      expect(await press(frameOf(page, 'cdn-a.test'), 'frame-copy')).toBe('false');
      expect(clipboardNeedsRestart(host.context)).toBe(true);
      await page.reload();
      await expectAllowed(page, clipboard, ['sub.site-a.test']);
      // Measured (Patchright 1.63): in a tab open at the change, a cross-site (out-of-process)
      // frame keeps getting the init script after it was removed, reloads included, until the tab
      // closes or the browser restarts. If this starts failing, update templates.md and D56.
      expect(await press(frameOf(page, 'cdn-a.test'), 'frame-copy')).toBe('false');
      // A tab opened afterwards is the browser's own behaviour throughout.
      const fresh = await setUp(world);
      await expectAllowed(fresh.page, fresh.clipboard);
      expect(world.hosts).toHaveLength(1);
    });

    it('a change while the browser starts is applied once it runs (review #84 M1)', async () => {
      world = await templateWorld(stealth);
      const w = world;
      const id = w.template.templateId;
      let row = w.template;
      const clipboardWrites = async (templateId: string, deny: boolean) => {
        const running = w.supervisor.runningHost(templateId);
        if (running !== null) await applyClipboardPolicy(running.context, deny, logger);
      };
      const off = watchClipboardOnStart({
        templates: { get: async () => row },
        runtime: w.supervisor,
        ops: { restartHost: async () => undefined },
        clipboardWrites,
        bus: w.bus,
        logger,
      });
      try {
        const launching = w.launch('agent');
        await until(() => w.supervisor.host(id).state === 'starting', 10_000, 'starting');
        // The PATCH: committed, then its live call finds no running browser.
        row = { ...row, denyClipboardWrites: true };
        expect(w.supervisor.runningHost(id)).toBeNull();
        await clipboardWrites(id, true);
        const agent = await launching;
        await until(() => clipboardNeedsRestart(w.host().context), 10_000, 'the reconcile');
        const { page, clipboard } = await setUp(w, agent);
        await expectDenied(page, clipboard);
      } finally {
        off();
      }
    });
  });
}
