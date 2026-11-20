/// <reference lib="dom" />
/** @module test/integration/template-tools.test — the tool table of spec 13 §5.5 on a real template host (§3.3, §3.10; §17 T1a acceptance): background tabs stay visible and take screenshots, the sequence that stalled a minimized window (popup, dialog, download) still yields a screenshot within 15 s, `set_viewport` fits a headed window, `switch_tab` and the live view stream. */

import { afterEach, describe, expect, it } from 'bun:test';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { Session } from '../../src/domain/session/session.ts';
import { createCollectingLogger } from '../../src/infra/logging/collecting-logger.ts';
import { playwrightBridgeFactory } from '../../src/interface/ws/cdp-bridge.ts';
import { type LiveFrame, LiveView } from '../../src/interface/ws/live-view.ts';
import { textOf } from '../helpers/fake-transport.ts';
import { HEADED, STEALTH_LEGS } from './template-fixture.ts';
import { type TemplateMcp, templateMcp } from './template-mcp-fixture.ts';

let world: TemplateMcp | null = null;
afterEach(async () => {
  await world?.stop();
  world = null;
});

function ok(result: CallToolResult): CallToolResult {
  if (result.isError === true) throw new Error(textOf(result));
  return result;
}

function sessionOf(w: TemplateMcp, id: string): Session {
  const session = w.harness.services.sessions.peek(id);
  if (session === undefined) throw new Error(`no session ${id}`);
  return session;
}

async function launch(w: TemplateMcp, extra: Record<string, unknown> = {}): Promise<string> {
  const launched = await w.harness.callJson<{ session_id: string }>('launch_session', {
    slug: 'tools',
    template: w.template.name,
    ...extra,
  });
  return launched.session_id;
}

function image(result: CallToolResult): boolean {
  return result.content.some((c) => c.type === 'image' && c.data.length > 100);
}

for (const stealth of STEALTH_LEGS) {
  describe(`template tools (stealth ${stealth}${HEADED ? ', headed' : ''})`, () => {
    it('background tabs stay visible, take screenshots and switch without raising a window', async () => {
      world = await templateMcp(stealth);
      const w = world;
      const id = await launch(w);
      const call = (name: string, args: Record<string, unknown> = {}) =>
        w.harness.call(name, { session_id: id, ...args });
      ok(await call('navigate', { url: w.sites.url('site-a.test') }));
      const first = sessionOf(w, id).tabs.activeTabId();
      ok(await call('new_tab', { url: w.sites.url('site-b.test', '/landing') }));
      const session = sessionOf(w, id);
      const background = session.tabs.entries().find(([tab]) => tab === first)?.[1];
      if (background === undefined || first === null) throw new Error('no first tab');
      expect(
        await background.evaluate(() => [document.visibilityState, document.hasFocus()]),
      ).toEqual(['visible', true]);
      expect(image(ok(await call('screenshot', { tab_id: first })))).toBe(true);
      ok(await call('switch_tab', { tab_id: first }));
      expect(session.tabs.activeTabId()).toBe(first);
      expect(image(ok(await call('screenshot')))).toBe(true);
    });

    it('an inner-scroll feed: scroll moves it, the tab survives PageDown, URL rewrites and a prerender, screenshots report their size (workload test B2-B4)', async () => {
      world = await templateMcp(stealth);
      const w = world;
      const id = await launch(w);
      const call = (name: string, args: Record<string, unknown> = {}) =>
        w.harness.call(name, { session_id: id, ...args });
      const json = async (name: string, args: Record<string, unknown> = {}) =>
        JSON.parse(textOf(ok(await call(name, args)))) as Record<string, unknown>;
      ok(await call('navigate', { url: w.sites.url('site-a.test', '/inner-feed') }));
      // B4: the document does not scroll; the feed does, and scroll says so.
      expect(await json('scroll', { mode: 'by', dy: 700 })).toMatchObject({
        x: 0,
        y: 700,
        target: 'element',
        element: 'main#feed',
      });
      const smooth = await json('scroll', { mode: 'by', dy: 700, behavior: 'smooth' });
      expect(smooth).toMatchObject({ y: 1400, target: 'element' });
      expect(await json('scroll', { mode: 'to', x: 0, y: 100 })).toMatchObject({ y: 100 });
      // B2: PageDown, replaceState and pushState rewrites keep the session's one tab.
      ok(await call('click', { selector: '#feed article >> nth=2' }));
      ok(await call('press_key', { key: 'PageDown' }));
      for (let i = 0; i < 4; i++) ok(await call('scroll', { mode: 'by', dy: 2_000 }));
      // B3: the image's own size, for the viewport and for a clip.
      const shot = ok(await call('screenshot'));
      const size = shot.structuredContent as { width: number; height: number };
      expect(size.width).toBeGreaterThan(100);
      expect(size.height).toBeGreaterThan(100);
      const clipped = ok(
        await call('screenshot', { clip: { x: 0, y: 0, width: 400, height: 120 } }),
      );
      expect(clipped.structuredContent).toMatchObject({ width: 400, height: 120 });
      const tabs = JSON.parse(textOf(ok(await call('list_tabs')))) as { url: string }[];
      expect(tabs).toHaveLength(1);
      expect(tabs[0]?.url).toContain('/inner-feed?');
      // A link to the prerendered page activates it; the session still has its tab.
      ok(await call('click', { selector: '#next' }));
      ok(await call('wait_for_url', { url: '**/landing?prerendered' }));
      expect(await json('session_info')).toMatchObject({ page_count: 1 });
      expect(image(ok(await call('screenshot')))).toBe(true);
      const after = JSON.parse(textOf(ok(await call('list_tabs')))) as { url: string }[];
      expect(after.map((t) => new URL(t.url).pathname)).toEqual(['/landing']);
      // `to` on a layout that overflows sideways still moves the feed (review #88 L2).
      ok(await call('navigate', { url: w.sites.url('site-a.test', '/inner-feed?wide') }));
      expect(await json('scroll', { mode: 'to', x: 0, y: 300 })).toMatchObject({
        y: 300,
        target: 'element',
        element: 'main#feed',
      });
    });

    it('a minimized window after a popup, a dialog and a download still yields a screenshot within 15 s', async () => {
      world = await templateMcp(stealth);
      const w = world;
      await w.harness.templates.repos.templates.update(w.template.templateId, {
        agentWindows: 'minimized',
      });
      const id = await launch(w);
      const call = (name: string, args: Record<string, unknown> = {}) =>
        w.harness.call(name, { session_id: id, ...args });
      ok(await call('navigate', { url: w.sites.url('site-a.test', '/stall') }));
      const first = sessionOf(w, id).tabs.activeTabId();
      ok(await call('click', { selector: '#popup' }));
      ok(await call('accept_next_dialog'));
      ok(await call('click', { selector: '#dialog' }));
      ok(await call('download_file', { trigger_selector: '#download' }));
      // The background tab (the popup took the front) in a minimized window.
      const started = Date.now();
      const shot = ok(await call('screenshot', { tab_id: first }));
      expect(Date.now() - started).toBeLessThan(15_000);
      expect(image(shot)).toBe(true);
    }, 60_000);

    it('set_viewport resizes the page, and a headed window with it', async () => {
      world = await templateMcp(stealth);
      const w = world;
      const id = await launch(w);
      ok(await w.harness.call('navigate', { session_id: id, url: w.sites.url('site-a.test') }));
      ok(await w.harness.call('set_viewport', { session_id: id, width: 700, height: 500 }));
      const page = sessionOf(w, id).view?.page;
      if (page === undefined) throw new Error('no page');
      expect(page.viewportSize()).toEqual({ width: 700, height: 500 });
      if (HEADED) {
        const host = w.supervisor.runningHost(w.template.templateId);
        const browser = page.context().browser();
        if (host === null || browser === null) throw new Error('no host');
        const cdp = await browser.newBrowserCDPSession();
        const target = (
          await (await page.context().newCDPSession(page)).send('Target.getTargetInfo')
        ).targetInfo.targetId;
        const { windowId } = await cdp.send('Browser.getWindowForTarget', { targetId: target });
        const { bounds } = await cdp.send('Browser.getWindowBounds', { windowId });
        await cdp.detach();
        expect(bounds.width).toBe(700);
        expect(bounds.height).toBe(500);
      }
    });

    it('the live view streams a template session', async () => {
      world = await templateMcp(stealth);
      const w = world;
      const id = await launch(w);
      ok(await w.harness.call('navigate', { session_id: id, url: w.sites.url('site-a.test') }));
      const sessions = w.harness.services.sessions;
      const live = new LiveView({
        sessions,
        bridges: playwrightBridgeFactory((s) => sessions.page(s)),
        pageOf: (s) => sessions.page(s),
        logger: createCollectingLogger(),
        schedule: (fn, ms) => {
          const timer = setTimeout(fn, ms);
          return () => clearTimeout(timer);
        },
      });
      const frames: LiveFrame[] = [];
      let resolve: () => void = () => undefined;
      const first = new Promise<void>((r) => {
        resolve = r;
      });
      await live.addViewer(id, {
        id: 'viewer-1',
        maxWidth: 640,
        maxHeight: 480,
        frame: (f) => {
          frames.push(f);
          resolve();
        },
        meta: () => undefined,
        stopped: () => undefined,
        failed: () => undefined,
      });
      ok(await w.harness.call('navigate', { session_id: id, url: w.sites.url('site-b.test') }));
      await Promise.race([first, Bun.sleep(10_000)]);
      await live.removeViewer(id, 'viewer-1');
      expect(frames.length).toBeGreaterThan(0);
      expect(frames[0]?.jpeg.byteLength ?? 0).toBeGreaterThan(100);
    });
  });
}
