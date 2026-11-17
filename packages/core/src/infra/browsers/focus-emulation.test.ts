/** @module infra/browsers/focus-emulation.test — `CdpPageFocus` over a scripted page (spec 13 §3.10, §9.4 `single-focus`): an untouched page is left to the driver's default; turning focus off attaches one extra DevTools session and sends `Emulation.setFocusEmulationEnabled {enabled: false}`, re-sent after each main-frame navigation; turning it on again sends `true` and stops the re-sends; a closed page detaches and is forgotten; failures never throw. The real-Chromium behaviour is pinned by `test/integration/site-pack-strategies-actions.test.ts`. */

import { describe, expect, it } from 'bun:test';
import type { Page } from 'patchright';
import { createCollectingLogger } from '../../../test/helpers/test-logger.ts';
import { CdpPageFocus } from './focus-emulation.ts';

class ScriptedPage {
  readonly sent: boolean[] = [];
  readonly windows: string[] = [];
  readonly listeners = new Map<string, ((arg: unknown) => void)[]>();
  sessions = 0;
  detached = 0;
  closed = false;
  failSend = false;
  readonly frame = {};
  context() {
    return {
      newCDPSession: async () => {
        this.sessions += 1;
        return {
          send: async (method: string, params?: Record<string, unknown>) => {
            if (this.failSend) throw new Error('Target closed');
            if (method === 'Browser.getWindowForTarget') return { windowId: 7 };
            if (method === 'Browser.setWindowBounds') {
              const bounds = params?.['bounds'] as { windowState: string };
              this.windows.push(`${String(params?.['windowId'])}:${bounds.windowState}`);
              return {};
            }
            this.sent.push(params?.['enabled'] === true);
            return {};
          },
          detach: async () => {
            this.detached += 1;
          },
        };
      },
    };
  }
  mainFrame() {
    return this.frame;
  }
  isClosed() {
    return this.closed;
  }
  on(event: string, fn: (arg: unknown) => void) {
    this.listeners.set(event, [...(this.listeners.get(event) ?? []), fn]);
  }
  once(event: string, fn: (arg: unknown) => void) {
    this.on(event, fn);
  }
  emit(event: string, arg: unknown) {
    for (const fn of this.listeners.get(event) ?? []) fn(arg);
  }
}

const asPage = (p: ScriptedPage): Page => p as unknown as Page;
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('CdpPageFocus', () => {
  it('leaves an untouched page to the driver default', async () => {
    const focus = new CdpPageFocus(createCollectingLogger(), true);
    const page = new ScriptedPage();
    await focus.setEmulated(asPage(page), true, false);
    expect(page.sessions).toBe(0);
    expect(focus.isUnfocused(asPage(page))).toBe(false);
  });

  it('turns focus off once, re-sends it after main-frame navigations, and back on', async () => {
    const focus = new CdpPageFocus(createCollectingLogger(), true);
    const page = new ScriptedPage();
    await focus.setEmulated(asPage(page), false, false);
    await focus.setEmulated(asPage(page), false, false);
    expect(page.sessions).toBe(1);
    expect(page.sent).toEqual([false]);
    expect(focus.isUnfocused(asPage(page))).toBe(true);
    page.emit('framenavigated', page.frame);
    page.emit('framenavigated', {});
    await flush();
    expect(page.sent).toEqual([false, false]);
    await focus.setEmulated(asPage(page), true, false);
    page.emit('framenavigated', page.frame);
    await flush();
    expect(page.sent).toEqual([false, false, true]);
    expect(focus.isUnfocused(asPage(page))).toBe(false);
  });

  it('headless: minimizes the window of an unfocused page and restores it with its focus', async () => {
    const focus = new CdpPageFocus(createCollectingLogger(), true);
    const page = new ScriptedPage();
    await focus.setEmulated(asPage(page), false, true);
    expect(page.windows).toEqual(['7:minimized']);
    await focus.setEmulated(asPage(page), true, true);
    expect(page.windows).toEqual(['7:minimized', '7:normal']);
    // Headed: windows are never touched.
    const headed = new ScriptedPage();
    await focus.setEmulated(asPage(headed), false, false);
    await focus.setEmulated(asPage(headed), true, false);
    expect(headed.windows).toEqual([]);
  });

  it('keeps a shared window minimized while another unfocused page is in it', async () => {
    const focus = new CdpPageFocus(createCollectingLogger(), true);
    const one = new ScriptedPage();
    const two = new ScriptedPage();
    await focus.setEmulated(asPage(one), false, true);
    await focus.setEmulated(asPage(two), false, true);
    await focus.setEmulated(asPage(one), true, true);
    expect([...one.windows, ...two.windows]).toEqual(['7:minimized', '7:minimized']);
    await focus.setEmulated(asPage(two), true, true);
    expect(two.windows).toEqual(['7:minimized', '7:normal']);
  });

  it('forgets a closed page and never throws', async () => {
    const focus = new CdpPageFocus(createCollectingLogger(), true);
    const page = new ScriptedPage();
    await focus.setEmulated(asPage(page), false, false);
    page.emit('close', undefined);
    await flush();
    expect(page.detached).toBe(1);
    expect(focus.isUnfocused(asPage(page))).toBe(false);
    const failing = new ScriptedPage();
    failing.failSend = true;
    await focus.setEmulated(asPage(failing), false, false);
    const closed = new ScriptedPage();
    closed.closed = true;
    await focus.setEmulated(asPage(closed), false, false);
    expect(closed.sessions).toBe(0);
  });
});
