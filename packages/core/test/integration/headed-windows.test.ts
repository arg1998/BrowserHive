/// <reference lib="dom" />
/** @module test/integration/headed-windows.test — headed windows kept minimized (`headedWindows`, template `agent_windows`, D-77) on a real display with a window manager: an exclusive session's first window opens minimized without taking the focus, its tabs open in the background, a site's popup or tab is minimized again, a persistent profile's first window is minimized after launch, the operator's restore is respected, `normal` opts out; what a minimized page sees, its screenshots and screencast; the same for a template's agent windows, with `new_tab` and `set_viewport` never restoring one. Runs where `BROWSERHIVE_HEADED_WM=1` (Linux, Xvfb with openbox: minimizing needs a window manager; CI's headed-windows leg). */

import { afterEach, describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { HeadedWindows } from '@browserhive/contracts/enums';
import type { CDPSession, Page } from 'patchright';
import { evaluateMainWorld } from '../../src/infra/browsers/evaluate.ts';
import {
  LATE_RESTORE_MS,
  RESTORE_POLL_MS,
  RESTORE_QUIET_MS,
} from '../../src/infra/browsers/headed-windows.ts';
import { PlaywrightBrowserDriver } from '../../src/infra/browsers/playwright-browser-driver.ts';
import { createSystemClock } from '../../src/infra/clock/system-clock.ts';
import { createCollectingLogger } from '../../src/infra/logging/collecting-logger.ts';
import { removeTree } from '../../src/kernel/remove.ts';
import type { LaunchSpec, SessionView } from '../../src/ports/browser-driver.ts';
import { type HttpsSites, startHttpsSites } from '../helpers/https-sites.ts';
import { integrationChannel } from '../helpers/integration-channel.ts';
import { HOST } from './driver-fixture.ts';
import { type TemplateWorld, templateWorld } from './template-fixture.ts';

/** A display with a window manager (minimizing is the window manager's job on X11). */
const WM = process.env['BROWSERHIVE_HEADED_WM'] === '1' && process.platform === 'linux';

/** Polls `read` until `ok` holds, or fails after `ms`. */
async function eventually<T>(
  read: () => Promise<T>,
  ok: (value: T) => boolean,
  ms = 5_000,
  what = 'condition',
): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await read();
    if (ok(value)) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}: ${String(value)}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

/** The X window with the input focus (`xdotool`). */
function focusedWindow(): string {
  return spawnSync('xdotool', ['getwindowfocus'], { encoding: 'utf8' }).stdout.trim();
}

/** The operator's window: a tiny X client given the input focus (a launch must not take it). */
function operatorWindow(): { readonly id: string; close(): void } {
  const child = Bun.spawn(['xmessage', '-name', 'bh-operator', 'operator window']);
  const found = spawnSync('xdotool', ['search', '--sync', '--classname', 'bh-operator'], {
    encoding: 'utf8',
    timeout: 10_000,
  });
  const id = found.stdout.trim().split('\n')[0] ?? '';
  if (found.status !== 0 || id === '') {
    child.kill();
    throw new Error('xmessage/xdotool unavailable on the headed-windows leg');
  }
  // The window manager may still be starting (CI starts openbox right before the suite, D30 n):
  // activate until the window really holds the focus, rather than once.
  const deadline = Date.now() + 10_000;
  while (focusedWindow() !== id) {
    if (Date.now() > deadline) {
      child.kill();
      throw new Error(`the operator window ${id} never got the focus (${focusedWindow()})`);
    }
    spawnSync('xdotool', ['windowactivate', '--sync', id], { timeout: 2_000 });
    if (focusedWindow() !== id) Bun.sleepSync(50);
  }
  return { id, close: () => child.kill() };
}

/** Window ids and states of pages, through one browser-level DevTools session. */
class Windows {
  private constructor(private readonly cdp: CDPSession) {}

  static async of(page: Page): Promise<Windows> {
    const browser = page.context().browser();
    if (browser === null) throw new Error('no browser');
    return new Windows(await browser.newBrowserCDPSession());
  }

  async windowOf(page: Page): Promise<number> {
    const cdp = await page.context().newCDPSession(page);
    try {
      const { targetInfo } = await cdp.send('Target.getTargetInfo');
      return (await this.cdp.send('Browser.getWindowForTarget', { targetId: targetInfo.targetId }))
        .windowId;
    } finally {
      await cdp.detach().catch(() => undefined);
    }
  }

  async stateOf(page: Page): Promise<string> {
    const windowId = await this.windowOf(page);
    return (await this.cdp.send('Browser.getWindowBounds', { windowId })).bounds.windowState ?? '';
  }

  /** What the operator does in the taskbar. */
  async restore(page: Page): Promise<void> {
    const windowId = await this.windowOf(page);
    await this.cdp.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'normal' } });
  }

  async dispose(): Promise<void> {
    await this.cdp.detach().catch(() => undefined);
  }
}

/** The page a click opens, as the context sees it. */
async function opened(page: Page, selector: string): Promise<Page> {
  const next = page.context().waitForEvent('page');
  await page.click(selector);
  return await next;
}

/** Polls the X input focus without blocking the event loop until `done()`; returns the samples. */
async function sampleFocus(done: () => boolean): Promise<string[]> {
  const samples: string[] = [];
  while (!done()) {
    const child = Bun.spawn(['xdotool', 'getwindowfocus'], { stdout: 'pipe' });
    samples.push((await new Response(child.stdout).text()).trim());
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
  return samples;
}

/** One exclusive headed session on its own driver. */
interface Exclusive {
  readonly view: SessionView;
  readonly page: Page;
  readonly windows: Windows;
}

let sites: HttpsSites | null = null;
let views: SessionView[] = [];
let dataDir: string | null = null;
let world: TemplateWorld | null = null;
let probes: Windows[] = [];

afterEach(async () => {
  for (const probe of probes) await probe.dispose();
  probes = [];
  for (const view of views) await view.close(10_000).catch(() => undefined);
  views = [];
  sites?.stop();
  sites = null;
  if (dataDir !== null) await removeTree(dataDir).catch(() => undefined);
  dataDir = null;
  await world?.stop();
  world = null;
});

async function launchExclusive(
  headedWindows: HeadedWindows,
  options: {
    readonly persistent?: boolean;
    readonly stealth?: boolean;
    /** `null`: no emulated viewport (what every headed stealth session has). */
    readonly viewport?: null;
  } = {},
): Promise<Exclusive> {
  sites ??= startHttpsSites();
  dataDir ??= await mkdtemp(join(tmpdir(), 'bh-headed-'));
  const driver = new PlaywrightBrowserDriver({
    logger: createCollectingLogger(),
    clock: createSystemClock(),
    host: HOST,
    headedWindows,
    testingArgs: sites.chromiumArgs,
  });
  const sessionId = `headed-${views.length}`;
  const sessionDir = join(dataDir, sessionId);
  const spec: LaunchSpec = {
    sessionId,
    channel: integrationChannel(),
    incognito: false,
    headless: false,
    persistenceMode: options.persistent === true ? 'persistent' : 'memory',
    ...(options.persistent === true && { userDataDir: join(sessionDir, 'profile') }),
    stealth: options.stealth ?? true,
    proxy: null,
    downloadsDir: join(sessionDir, 'downloads'),
    ...(options.viewport === null && { contextOptions: { viewport: null } }),
  };
  const { view } = await driver.launch(spec);
  views.push(view);
  const page = view.page;
  const windows = await Windows.of(page);
  probes.push(windows);
  return { view, page, windows };
}

describe.skipIf(!WM)('headed windows kept minimized (headedWindows=minimized, D-77)', () => {
  for (const [stealth, viewport] of [
    [true, null],
    [true, undefined],
    [false, undefined],
  ] as const) {
    it(`an exclusive session's first window opens minimized and never takes the focus (stealth ${stealth}, viewport ${viewport === null ? 'null' : 'emulated'})`, async () => {
      const operator = operatorWindow();
      try {
        expect(focusedWindow()).toBe(operator.id);
        const s = await launchExclusive('minimized', {
          stealth,
          ...(viewport === null && { viewport }),
        });
        expect(await s.windows.stateOf(s.page)).toBe('minimized');
        expect(focusedWindow()).toBe(operator.id);
        await s.page.goto(sites?.url('site-a.test') ?? '');
        expect(await s.windows.stateOf(s.page)).toBe('minimized');
        // A new tab never shows: a new minimized window, whose page is its front tab, so its
        // outer size is a real window's (a background tab's equals its inner size, review #89 F6).
        const tab = await s.view.newPage();
        expect(await s.windows.windowOf(tab)).not.toBe(await s.windows.windowOf(s.page));
        expect(await s.windows.stateOf(tab)).toBe('minimized');
        await tab.goto(sites?.url('site-a.test') ?? '');
        const sizes = await evaluateMainWorld(tab, true, () => [
          window.outerWidth - window.innerWidth,
          window.outerHeight - window.innerHeight,
        ]);
        if (viewport === null) expect(sizes[1]).toBeGreaterThan(0);
        expect(await s.windows.stateOf(s.page)).toBe('minimized');
        expect(focusedWindow()).toBe(operator.id);
      } finally {
        operator.close();
      }
    });
  }

  it("a site's popup and a target=_blank tab (which restores the window) are minimized again", async () => {
    const s = await launchExclusive('minimized');
    await s.page.goto(sites?.url('site-a.test') ?? '');
    const popup = await opened(s.page, '#popup-window');
    await eventually(
      () => s.windows.stateOf(popup),
      (v) => v === 'minimized',
      5_000,
      'popup',
    );
    const tab = await opened(s.page, '#blank');
    expect(await s.windows.windowOf(tab)).toBe(await s.windows.windowOf(s.page));
    await eventually(
      () => s.windows.stateOf(s.page),
      (v) => v === 'minimized',
      5_000,
      'tab',
    );
  });

  for (const viewport of [null, undefined] as const) {
    it(`a click restores the window and takes the focus; the tool call minimizes it again (viewport ${viewport === null ? 'null' : 'emulated'})`, async () => {
      const s = await launchExclusive('minimized', viewport === null ? { viewport } : {});
      await s.page.goto(sites?.url('site-a.test') ?? '');
      const around = s.view.aroundAction?.bind(s.view);
      if (around === undefined) throw new Error('no aroundAction');
      // Chromium restores the window a moment after the press or the resize returns, so the read
      // at the end of the call can still say minimized; the keeper's second looks
      // (LATE_RESTORE_MS) minimize it again, which is what the call guarantees (D30 n: measured
      // under openbox, 1 click in 12 read normal right after the call).
      const minimizedAgain = () =>
        eventually(
          () => s.windows.stateOf(s.page),
          (v) => v === 'minimized',
          Math.max(...LATE_RESTORE_MS) + 700,
          'the window minimized again',
        );
      await around(() => s.page.click('#site'));
      await minimizedAgain();
      await around(() => s.page.setViewportSize({ width: 700, height: 500 }));
      await minimizedAgain();
      expect(s.page.viewportSize()).toEqual({ width: 700, height: 500 });
    });
  }

  it('the window stays minimized for the whole call: a click whose call goes on, and typing after it (review #89 F1)', async () => {
    const operator = operatorWindow();
    try {
      const s = await launchExclusive('minimized', { viewport: null });
      await s.page.goto(sites?.url('site-a.test') ?? '');
      await s.page.setContent('<input id="i" style="width:300px">');
      const around = s.view.aroundAction?.bind(s.view);
      if (around === undefined) throw new Error('no aroundAction');
      spawnSync('xdotool', ['windowactivate', '--sync', operator.id], { timeout: 10_000 });
      let finished = false;
      const sampling = sampleFocus(() => finished);
      // A click whose call lasts on (a slow navigation), then human-paced typing in the page.
      await around(async () => {
        await s.page.click('#i');
        await new Promise((resolve) => setTimeout(resolve, 1_000));
        await s.page.keyboard.type('hello world', { delay: 60 });
      });
      finished = true;
      const samples = await sampling;
      const away = samples.filter((id) => id !== operator.id).length;
      // At most one sample in the ~40 ms between a press and the next minimize.
      expect(away).toBeLessThanOrEqual(2);
      expect(samples.length).toBeGreaterThan(20);
      expect(await s.page.inputValue('#i')).toBe('hello world');
      expect(await s.windows.stateOf(s.page)).toBe('minimized');
    } finally {
      operator.close();
    }
  }, 20_000);

  it('a parallel call never leaves the window restored (review #89 F2)', async () => {
    const s = await launchExclusive('minimized', { viewport: null });
    await s.page.goto(sites?.url('site-a.test') ?? '');
    await new Promise((resolve) => setTimeout(resolve, 700));
    const around = s.view.aroundAction?.bind(s.view);
    if (around === undefined) throw new Error('no aroundAction');
    const slowClick = around(async () => {
      await s.page.click('#site');
      await new Promise((resolve) => setTimeout(resolve, 1_500));
    });
    await new Promise((resolve) => setTimeout(resolve, 300));
    await around(() => s.page.screenshot({ timeout: 10_000 }));
    await slowClick;
    await eventually(
      () => s.windows.stateOf(s.page),
      (v) => v === 'minimized',
      2_000,
      'after',
    );
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    await around(() => s.page.click('#site'));
    expect(await s.windows.stateOf(s.page)).toBe('minimized');
  }, 20_000);

  it('a window the operator restored by hand stays restored through clicks', async () => {
    const s = await launchExclusive('minimized', { viewport: null });
    await s.page.goto(sites?.url('site-a.test') ?? '');
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    await s.windows.restore(s.page);
    await s.view.aroundAction?.(() => s.page.click('#site'));
    expect(await s.windows.stateOf(s.page)).toBe('normal');
  });

  it('a window the operator restored by hand stays restored when a site opens a tab in it', async () => {
    const s = await launchExclusive('minimized');
    await s.page.goto(sites?.url('site-a.test') ?? '');
    // A person restores a window later than the keeper's last look after creating it.
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    await s.windows.restore(s.page);
    // The keeper notices the restore on its next poll (after the quiet period of the launch).
    await new Promise((resolve) => setTimeout(resolve, RESTORE_QUIET_MS + RESTORE_POLL_MS + 1_000));
    await opened(s.page, '#blank');
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    expect(await s.windows.stateOf(s.page)).toBe('normal');
  }, 20_000);

  it("a persistent profile's first window is minimized right after the launch", async () => {
    const s = await launchExclusive('minimized', { persistent: true });
    await eventually(
      () => s.windows.stateOf(s.page),
      (v) => v === 'minimized',
      5_000,
      'first',
    );
    const tab = await s.view.newPage();
    await eventually(
      () => s.windows.stateOf(tab),
      (v) => v === 'minimized',
      5_000,
      'tab',
    );
  });

  it('headedWindows=normal opens normal windows (the opt-out)', async () => {
    const s = await launchExclusive('normal');
    expect(await s.windows.stateOf(s.page)).toBe('normal');
    const tab = await s.view.newPage();
    expect(await s.windows.stateOf(tab)).toBe('normal');
  });

  it('a minimized page sees what a normal window sees, and screenshots and screencast work', async () => {
    const s = await launchExclusive('minimized');
    const normal = await launchExclusive('normal');
    const signals = (page: Page) =>
      evaluateMainWorld(page, true, () => ({
        visibility: document.visibilityState,
        focus: document.hasFocus(),
        inner: [window.innerWidth, window.innerHeight],
        outer: [window.outerWidth, window.outerHeight],
        screen: [screen.width, screen.height, screen.availWidth, screen.availHeight],
      }));
    await s.page.goto(sites?.url('site-a.test') ?? '');
    await normal.page.goto(sites?.url('site-a.test') ?? '');
    const seen = await signals(s.page);
    expect(seen.visibility).toBe('visible');
    expect(seen.focus).toBe(true);
    // Measured (Chromium 153, Xvfb + openbox): no page-visible difference from a normal window.
    expect(seen).toEqual(await signals(normal.page));
    const frames = await evaluateMainWorld(s.page, true, async () => {
      let n = 0;
      const started = performance.now();
      await new Promise<void>((resolve) => {
        const step = () => {
          n++;
          if (performance.now() - started < 1_000) requestAnimationFrame(step);
          else resolve();
        };
        requestAnimationFrame(step);
      });
      return n;
    });
    // Animation frames run unthrottled (about 60 per second) in a minimized window.
    expect(frames).toBeGreaterThan(30);
    const shot = await s.page.screenshot({ timeout: 10_000 });
    expect(shot.length).toBeGreaterThan(1_000);
    const cdp = await s.view.newCDPSession(s.page);
    let count = 0;
    cdp.on('Page.screencastFrame', ({ sessionId }) => {
      count++;
      void cdp.send('Page.screencastFrameAck', { sessionId }).catch(() => undefined);
    });
    await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 50 });
    await s.page.evaluate(() => {
      setInterval(() => {
        document.body.style.background = `hsl(${Math.round(Math.random() * 360)} 50% 50%)`;
      }, 50);
    });
    await eventually(
      async () => count,
      (n) => n >= 3,
      5_000,
      'screencast frames',
    );
    await cdp.send('Page.stopScreencast');
    await cdp.detach();
    expect(await s.windows.stateOf(s.page)).toBe('minimized');
  });
});

describe.skipIf(!WM || process.env['BROWSERHIVE_TEMPLATES_HEADED'] !== '1')(
  "a template's agent windows kept minimized (agent_windows=minimized, D-77)",
  () => {
    it('popups and tabs are minimized again; new_tab and set_viewport never restore a window', async () => {
      world = await templateWorld('standard', { template: { agentWindows: 'minimized' } });
      const session = await world.launch('alpha');
      const view = session.view;
      if (view === null) throw new Error('no view');
      const page = view.page;
      const windows = await Windows.of(page);
      probes.push(windows);
      expect(await windows.stateOf(page)).toBe('minimized');
      await page.goto(world.sites.url('site-a.test'));
      // new_tab: a new minimized window, not a window.open tab (it would restore the window).
      const tab = await view.newPage(page);
      expect(await windows.windowOf(tab)).not.toBe(await windows.windowOf(page));
      expect(await windows.stateOf(tab)).toBe('minimized');
      expect(await windows.stateOf(page)).toBe('minimized');
      // set_viewport: the page is resized, the minimized window is not restored.
      await page.setViewportSize({ width: 700, height: 500 });
      await view.fitWindow?.(page, 700, 500);
      expect(await windows.stateOf(page)).toBe('minimized');
      const popup = await opened(page, '#popup-window');
      await eventually(
        () => windows.stateOf(popup),
        (v) => v === 'minimized',
        5_000,
        'popup',
      );
      await opened(page, '#blank');
      await eventually(
        () => windows.stateOf(page),
        (v) => v === 'minimized',
        5_000,
        'tab',
      );
      const shot = await page.screenshot({ timeout: 10_000 });
      expect(shot.length).toBeGreaterThan(1_000);
    }, 60_000);
  },
);
