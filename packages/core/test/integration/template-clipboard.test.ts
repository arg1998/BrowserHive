/// <reference lib="dom" />
/** @module test/integration/template-clipboard.test — "Deny clipboard writes" on a real template host (spec 13 §2.1, §13 "The operator's desktop"; D18), template stealth off and standard: with the switch off a page's `navigator.clipboard` writes and `execCommand('copy')` after a real click reach the clipboard, from any frame, and its `copy` listener rewrites a person's own Ctrl/Cmd+C, also after it replaced its document; with it on at host start every one of those is refused, including the bypasses of review #84 (a `toString` that answers twice, built-ins replaced to steal the native method, a trap on `Object.prototype`, other realms: frames loaded with the page, sandboxed, cross-site out-of-process frames, a popup) and of verify #84 (opaque sandboxed `srcdoc` frames, kept in their page's process: N1; `document.open`/`write` dropping the copy stopper: N2), the clipboard keeps what the operator put there and a person's copy is what they selected; applied live it reaches every frame of the open page at once and a page restored from the back/forward cache (N3), and only a reference taken before the change survives until the document reloads (the host then says a restart gives full effect), as does a sandboxed frame loaded later in a browser started without the sandboxed-frames switch; turning it off live lifts the permission at once and the rest at the next load; a change while the browser starts is applied once it runs. */

import { afterEach, describe, expect, it } from 'bun:test';
import type { Page } from 'patchright';
import { watchClipboardOnStart } from '../../src/app/templates/clipboard-switch.ts';
import {
  applyClipboardPolicy,
  clipboardNeedsRestart,
} from '../../src/infra/browsers/clipboard-policy.ts';
import { createCollectingLogger } from '../../src/infra/logging/collecting-logger.ts';
import {
  buttonsOf,
  type ClipboardReader,
  clickNestedSandboxCopy,
  copyAfterReplace,
  frameById,
  frameOf,
  framesOf,
  outOfProcess,
  permissionState,
  press,
  REPLACERS,
  sandboxedFramesOf,
  setUp,
} from './clipboard-fixture.ts';
import { STEALTH_LEGS, type TemplateWorld, templateWorld, until } from './template-fixture.ts';

const logger = createCollectingLogger();

let world: TemplateWorld | null = null;
afterEach(async () => {
  await world?.stop();
  world = null;
});

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
  // Opaque sandboxed `srcdoc` frames, nested ones and those in cross-site frames (verify #84 N1).
  for (const [label, frame] of await sandboxedFramesOf(page)) {
    expect([label, await press(frame, 'own-copy')]).toEqual([label, 'false']);
  }
  await clickNestedSandboxCopy(page);
  expect(await press(page, 'popup-open')).toBe('opened');
  expect(await press(page, 'popup-copy')).toBe('false');
  expect(await clipboard.read(page)).toBe('operator text');
  // A person's copy inside a sandboxed frame is what they selected there.
  expect(await press(await frameById(page, 'sandbox-srcdoc'), 'own-hijack')).toBe('armed');
  await page.keyboard.press('ControlOrMeta+C');
  expect(await clipboard.read(page)).toBe('field text');
  await clipboard.seed('operator text', page);
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
      // Chromium's own process model for a sandboxed `srcdoc` frame (a process of its own), unless
      // stealth's identity script must reach it (verify #84 N1).
      expect(await outOfProcess(world, await frameById(page, 'sandbox-srcdoc'))).toBe(
        stealth === 'off',
      );
      expect(await press(await frameById(page, 'sandbox-srcdoc'), 'own-copy')).toBe('true');
      expect(await clipboard.read(page)).toBe('planted-by-sandbox-srcdoc');
      await clickNestedSandboxCopy(page);
      expect(await clipboard.read(page)).toBe('planted-by-sandbox-nested');
      // A page that replaces its document rewrites a person's copy (verify #84 N2, the control).
      for (const id of REPLACERS) {
        const planted = `planted-by-${id === 'docopen-hijack' ? 'docopen' : id}`;
        expect([id, ...(await copyAfterReplace(world, page, clipboard, id))]).toEqual([
          id,
          'armed',
          planted,
        ]);
      }
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
      // Sandboxed frames stay in their parent's process, where the init script reaches them.
      for (const [label, frame] of await sandboxedFramesOf(page)) {
        expect([label, await outOfProcess(world, frame)]).toEqual([label, false]);
      }
      await expectBypassesRefused(page, clipboard);
    });

    it('on at host start: a page that replaces its document cannot rewrite a copy (verify #84 N2)', async () => {
      world = await templateWorld(stealth, { template: { denyClipboardWrites: true } });
      const w = world;
      const { page, clipboard } = await setUp(w);
      for (const id of REPLACERS) {
        // Another realm's `document.open` on this document does nothing.
        const outcome = id === 'docopen-realm' ? 'refused' : 'armed';
        expect([id, ...(await copyAfterReplace(w, page, clipboard, id))]).toEqual([
          id,
          outcome,
          'field text',
        ]);
      }
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
      // A sandboxed `srcdoc` frame loaded after the change: a browser started without the
      // sandboxed-frames switch (stealth off, the switch off) runs it out of process, where no
      // init script reaches it until the restart (verify #84 N1, measured; templates.md and D56).
      expect(await press(page, 'sandbox-add')).toBe('loaded');
      await clipboard.seed('operator text', page);
      expect(await press(await frameById(page, 'sandbox-late'), 'own-copy')).toBe(
        stealth === 'off' ? 'true' : 'false',
      );
      // A document loaded afterwards is fully covered.
      await page.reload();
      expect(await savedCopy(page, clipboard)).toEqual(['false', 'operator text']);
      // The open document's own `document.open` keeps the stopper too (verify #84 N2).
      expect(await copyAfterReplace(world, page, clipboard, 'docwrite-capture')).toEqual([
        'armed',
        'field text',
      ]);
      expect(world.hosts).toHaveLength(1);
    });

    it('applied live: a page back from the back/forward cache is reached (verify #84 N3)', async () => {
      world = await templateWorld(stealth);
      const w = world;
      const { page, clipboard } = await setUp(w);
      await page.goto(w.sites.url('site-a.test', '/clipboard-restore'));
      // Patchright 1.63 loses a restored page with out-of-process frames (its `goBack` and clicks
      // never settle), so the restored page is driven through DevTools, the mouse and the keyboard.
      const at = await buttonsOf(page, [
        [page.mainFrame(), ['exec-copy', 'pre-iframe-copy', 'write-text', 'hijack', 'select-all']],
        [frameOf(page, 'cdn-a.test'), ['frame-copy']],
      ]);
      const cdp = await w.host().context.newCDPSession(page);
      const evaluate = async (expression: string): Promise<unknown> =>
        (await cdp.send('Runtime.evaluate', { expression, returnByValue: true })).result.value;
      await page.goto(w.sites.url('site-a.test', '/landing'));
      await applyClipboardPolicy(w.host().context, true, logger);
      const { entries, currentIndex } = await cdp.send('Page.getNavigationHistory');
      const back = entries[currentIndex - 1];
      if (back === undefined) throw new Error('no history entry');
      // The logger is the file's: only a record from this restore counts (the stealth-off leg logs
      // one first, which let the standard leg click before its own patch ran, D30 m).
      const logged = logger.records.length;
      await cdp.send('Page.navigateToHistoryEntry', { entryId: back.id });
      await until(
        () => logger.records.slice(logged).some((r) => r.msg === 'clipboard restore patched'),
        10_000,
      );
      // The document from before the change, as it was (not a new load), every frame patched.
      expect(await evaluate('window.__persisted')).toBe('yes');
      await clipboard.seed('operator text', page);
      const click = async (id: string): Promise<void> => {
        const point = at.get(id);
        if (point === undefined) throw new Error(`no button ${id}`);
        await page.mouse.click(point.x, point.y);
      };
      /** Clicks a main-document button and returns the outcome it reports in the title. */
      const outcome = async (id: string): Promise<string> => {
        await click(id);
        for (let i = 0; i < 200; i++) {
          const title = String(await evaluate('document.title'));
          if (title.startsWith(`${id}:`)) return title.slice(id.length + 1);
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
        throw new Error(`${id} reported nothing`);
      };
      expect(await outcome('exec-copy')).toBe('false');
      expect(await outcome('pre-iframe-copy')).toBe('false');
      expect(await outcome('write-text')).toBe('NotAllowedError');
      // The cross-site frame reports in its own title; the clipboard says whether it copied.
      await click('frame-copy');
      expect(await clipboard.read(page)).toBe('operator text');
      expect(await outcome('hijack')).toBe('armed');
      expect(await outcome('select-all')).toBe('true');
      await page.keyboard.press('ControlOrMeta+C');
      expect(await clipboard.read(page)).toBe('field text');
      await cdp.detach();
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
