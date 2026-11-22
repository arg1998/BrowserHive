/// <reference lib="dom" />
/** @module test/integration/template-no-window.test — a template host starts with no window (`--no-startup-window`, D-78) on a real browser: no page and no window at start, alive with none, BrowserHive's own closes never stop it and a page cannot close its window, the operator closing its last window (or the menu's Exit) stops it cleanly (sessions `operator`, a checkpoint while the browser is still up, then the browser), the sign-in window closed by hand leaves it up, a checkpoint never moves the focus. Every OS, headless and headed; the focus, window-list and Exit checks need Linux with a window manager (`BROWSERHIVE_HEADED_WM=1`, CI's openbox leg); on macOS and Windows the foreground app is logged, not asserted (not measured yet, D-items in deferred.md). */

import { afterEach, describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Channel } from '@browserhive/contracts/enums';
import { type BrowserContext, chromium, type Page } from 'patchright';
import { playwrightExecutable } from '../../src/infra/browsers/browser-detection.ts';
import { contextOptionsFor, deriveFingerprint } from '../../src/infra/browsers/fingerprint.ts';
import { hostArgv } from '../../src/infra/browsers/host-argv.ts';
import { readBrowserPid } from '../../src/infra/browsers/host-process.ts';
import type { PlaywrightTemplateHost } from '../../src/infra/browsers/template-host.ts';
import { hostLaunchOptions } from '../../src/infra/browsers/template-launch.ts';
import { createCollectingLogger } from '../../src/infra/logging/collecting-logger.ts';
import { removeTree } from '../../src/kernel/remove.ts';
import type { ProxySpec } from '../../src/ports/browser-driver.ts';
import type { TemplateHostSpec } from '../../src/ports/template-host.ts';
import { templateSiteRecord } from '../persistence/helpers.ts';
import { HEADED, type TemplateWorld, templateWorld, until } from './template-fixture.ts';
import { type OperatorWindow, operatorWindow as xOperatorWindow } from './x-desktop.ts';

const LINUX = process.platform === 'linux';
/** `xdotool` reads the X input focus on the Linux headed legs. */
const X = HEADED && LINUX;
/** A window manager runs (openbox): window lists, closing by hand and the menu's Exit. */
const WM = X && process.env['BROWSERHIVE_HEADED_WM'] === '1';
/** A headless host keeps one invisible anchor page (D-78); a headed host has none. */
const ANCHOR = HEADED ? 0 : 1;

let world: TemplateWorld | null = null;
afterEach(async () => {
  await world?.stop();
  world = null;
});

function sh(cmd: string, args: readonly string[]): string {
  const out = spawnSync(cmd, args, { encoding: 'utf8', timeout: 10_000 });
  return out.status === 0 ? out.stdout.trim() : '';
}

/** The window (Linux), or the app (macOS) or window handle (Windows) in front; `null` if unreadable. */
function foreground(): string | null {
  if (!HEADED) return null;
  if (LINUX) return sh('xdotool', ['getwindowfocus']) || null;
  if (process.platform === 'darwin') {
    // `lsappinfo` needs no automation permission (System Events would prompt on a runner).
    const front = sh('lsappinfo', ['front']);
    const app = front === '' ? '' : sh('lsappinfo', ['info', '-only', 'name', front]);
    return app === '' ? null : app;
  }
  if (process.platform === 'win32') {
    const handle = sh('powershell', [
      '-NoProfile',
      '-Command',
      'Add-Type -Name W -Namespace U -MemberDefinition \'[DllImport("user32.dll")] public static extern System.IntPtr GetForegroundWindow();\'; [U.W]::GetForegroundWindow()',
    ]);
    return handle === '' ? null : handle;
  }
  return null;
}

/** The windows the window manager manages (`_NET_CLIENT_LIST`). */
function clientWindows(): string[] {
  return sh('xprop', ['-root', '_NET_CLIENT_LIST']).match(/0x[0-9a-f]+/g) ?? [];
}

/**
 * The operator's window holding the focus (Linux headed legs; `null` elsewhere): with a window
 * manager only once the manager has activated it, so its startup is not sampled as a focus change.
 */
function operatorWindow(): OperatorWindow | null {
  return X ? xOperatorWindow(WM) : null;
}

/** Samples the X focus and the new managed windows until `stop()`, without blocking the loop. */
function watchDesktop(): { stop(): Promise<{ foci: Set<string>; windows: Set<string> }> } {
  const known = new Set(WM ? clientWindows() : []);
  const foci = new Set<string>();
  const windows = new Set<string>();
  let done = !X;
  const loop = (async () => {
    while (!done) {
      const focus = Bun.spawn(['xdotool', 'getwindowfocus'], { stdout: 'pipe' });
      foci.add((await new Response(focus.stdout).text()).trim());
      if (WM) {
        const list = Bun.spawn(['xprop', '-root', '_NET_CLIENT_LIST'], { stdout: 'pipe' });
        const ids = (await new Response(list.stdout).text()).match(/0x[0-9a-f]+/g) ?? [];
        for (const id of ids) if (!known.has(id)) windows.add(id);
      }
      await new Promise((resolve) => setTimeout(resolve, 15));
    }
  })();
  return {
    async stop() {
      done = true;
      await loop;
      return { foci, windows };
    },
  };
}

/** Starts the template's browser with no session (as a scheduled check or **Start** does). */
async function startHost(w: TemplateWorld): Promise<PlaywrightTemplateHost> {
  const lifecycle = w.supervisor.lifecycle(w.template);
  lifecycle.reserve(() => undefined);
  await lifecycle.acquire(AbortSignal.timeout(30_000));
  return w.host();
}

/** The browser's page targets, as Chromium lists them (a window has at least one). */
async function pageTargets(host: PlaywrightTemplateHost): Promise<number> {
  const browser = host.context.browser();
  if (browser === null) throw new Error('no browser');
  const cdp = await browser.newBrowserCDPSession();
  try {
    const { targetInfos } = await cdp.send('Target.getTargets');
    return targetInfos.filter((t) => t.type === 'page').length;
  } finally {
    await cdp.detach().catch(() => undefined);
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function pidOf(host: PlaywrightTemplateHost): Promise<number> {
  const pid = await host.browserPid();
  if (pid === null) throw new Error('no browser pid');
  return pid;
}

/**
 * Closes `page`'s window the way an operator does: with a window manager through
 * `_NET_CLOSE_WINDOW` (`wmctrl -c`, found by a unique title), elsewhere through a DevTools session
 * of the test's own (Chromium destroys the target; BrowserHive did not close it).
 */
async function closeByHand(page: Page): Promise<void> {
  if (WM) {
    const title = `bh-close-${Math.random().toString(36).slice(2)}`;
    await page.evaluate((t) => {
      document.title = t;
    }, title);
    let id = '';
    await until(
      () => {
        id = sh('xdotool', ['search', '--name', title]).split('\n')[0] ?? '';
        return id !== '';
      },
      5_000,
      'the window by its title',
    );
    spawnSync('wmctrl', ['-i', '-c', `0x${Number(id).toString(16)}`]);
    return;
  }
  const browser = page.context().browser();
  if (browser === null) throw new Error('no browser');
  const own = await page.context().newCDPSession(page);
  const { targetInfo } = await own.send('Target.getTargetInfo');
  await own.detach();
  const cdp = await browser.newBrowserCDPSession();
  await cdp.send('Target.closeTarget', { targetId: targetInfo.targetId });
  await cdp.detach().catch(() => undefined);
}

function pageOf(session: { readonly view: { readonly page: Page } | null }): Page {
  if (session.view === null) throw new Error('no view');
  return session.view.page;
}

describe(`template host with no window (${HEADED ? 'headed' : 'headless'})`, () => {
  it('starts with no page and no window, without moving the focus, and stays up with none', async () => {
    world = await templateWorld('standard');
    const operator = operatorWindow();
    try {
      const before = foreground();
      const desktop = watchDesktop();
      const host = await startHost(world);
      // A started host has nothing to show: no page target, so no window.
      expect(host.context.pages()).toHaveLength(ANCHOR);
      expect(await pageTargets(host)).toBe(ANCHOR);
      expect(host.anchorPage !== null).toBe(!HEADED);
      expect(host.parkedPages()).toEqual([]);
      await new Promise((resolve) => setTimeout(resolve, 2_000));
      const seen = await desktop.stop();
      if (X) expect([...seen.foci]).toEqual([operator?.id ?? '']);
      if (WM) expect([...seen.windows]).toEqual([]);
      // macOS and Windows are not measured yet (deferred): the foreground is reported, not asserted.
      if (!LINUX && HEADED) {
        process.stderr.write(
          `foreground before/after the host start: ${before} / ${foreground()}\n`,
        );
      }
      const pid = await pidOf(host);
      expect(alive(pid)).toBe(true);
      expect(host.context.browser()?.isConnected()).toBe(true);
      expect(world.supervisor.host(world.template.templateId).state).toBe('running');
      // A session's window closed by BrowserHive (close_session) leaves the browser up with none.
      const alpha = await world.launch('alpha');
      await world.sessions.close(alpha.id);
      await until(() => host.context.pages().length === ANCHOR, 5_000, 'no page left');
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      expect(await pageTargets(host)).toBe(ANCHOR);
      expect(world.supervisor.host(world.template.templateId).state).toBe('running');
      const bravo = await world.launch('bravo');
      expect(world.hosts).toHaveLength(1);
      await pageOf(bravo).goto(world.sites.url('site-a.test'));
      // Closed cleanly: the process goes away.
      await world.supervisor.stopHost(world.template.templateId, 'test');
      await until(() => !alive(pid), 10_000, 'the browser process exits');
    } finally {
      operator?.close();
    }
    // Two launches and a stop: slower runners (macOS, Windows) need more than the default limit.
  }, 90_000);

  it('a page cannot close its own window; a closed tab of a session never stops the browser', async () => {
    world = await templateWorld('standard');
    const alpha = await world.launch('alpha');
    const page = pageOf(alpha);
    await page.goto(world.sites.url('site-a.test'));
    // Chrome refuses: "Scripts may close only the windows that were opened by them".
    await page.evaluate(() => window.close());
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    expect(page.isClosed()).toBe(false);
    const { tabId } = await world.sessions.newTab(alpha);
    await world.sessions.closeTab(alpha, tabId);
    await page.close();
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    expect(world.supervisor.host(world.template.templateId).state).toBe('running');
    expect(alpha.closedReason).toBeNull();
  });

  // A headless host has no window an operator could close (and keeps its anchor page).
  it.if(HEADED)(
    "the operator closing the browser's last window stops it: sessions end (operator), a checkpoint first, then the browser",
    async () => {
      world = await templateWorld('standard');
      const w = world;
      const checkpoints: { connected: boolean; pages: number }[] = [];
      w.supervisor.attachCheckpoints({
        checkpoint: async (_id, host) => {
          const state = await host?.storageState();
          checkpoints.push({
            connected:
              (host as PlaywrightTemplateHost | undefined)?.context.browser()?.isConnected() ===
              true,
            pages: state === undefined ? -1 : state.cookies.length,
          });
        },
        checkpointIfDue: async () => undefined,
      });
      const alpha = await w.launch('alpha');
      const bravo = await w.launch('bravo');
      await pageOf(alpha).goto(w.sites.url('site-a.test'));
      const pid = await pidOf(w.host());
      // One window of two closed by hand: the browser and the other session go on.
      await closeByHand(pageOf(alpha));
      await until(() => pageOf(alpha).isClosed(), 5_000, "alpha's window closed");
      await new Promise((resolve) => setTimeout(resolve, 500));
      expect(w.supervisor.host(w.template.templateId).state).toBe('running');
      expect(bravo.closedReason).toBeNull();
      // The last one: an operator stop.
      await closeByHand(pageOf(bravo));
      const id = w.template.templateId;
      await until(() => w.supervisor.host(id).state === 'stopped', 15_000, 'the operator stop');
      expect(alpha.closedReason).toBe('operator');
      expect(bravo.closedReason).toBe('operator');
      // The checkpoint ran on the browser while it was still up, before it closed.
      expect(checkpoints).toHaveLength(1);
      expect(checkpoints[0]?.connected).toBe(true);
      await until(() => !alive(pid), 10_000, 'the browser process exits');
      expect(w.hosts).toHaveLength(1);
      expect(w.degradations.reports).toEqual([]);
      // Nothing restarts until the next launch, which starts a new browser.
      await w.launch('charlie');
      expect(w.hosts).toHaveLength(2);
    },
    60_000,
  );

  it("closing the browser's last session keeps the session-only cookies Chrome drops with its last window", async () => {
    world = await templateWorld('standard');
    const w = world;
    const alpha = await w.launch('alpha');
    await w
      .host()
      .context.addCookies([
        { name: 'bh_session_only', value: '1', url: 'https://site-a.test/', secure: true },
      ]);
    await w.sessions.close(alpha.id);
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    expect(w.hosts).toHaveLength(1);
    expect((await w.host().jar()).find((c) => c.name === 'bh_session_only')?.value).toBe('1');
  });

  it("close_tab of the browser's last tab keeps the session-only cookies too", async () => {
    world = await templateWorld('standard');
    const w = world;
    const alpha = await w.launch('alpha');
    await w
      .host()
      .context.addCookies([
        { name: 'bh_session_only', value: '1', url: 'https://site-a.test/', secure: true },
      ]);
    const tabId = alpha.tabs.activeTabId();
    if (tabId === undefined) throw new Error('no tab');
    await w.sessions.closeTab(alpha, tabId);
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    expect(await pageTargets(w.host())).toBe(ANCHOR);
    expect((await w.host().jar()).find((c) => c.name === 'bh_session_only')?.value).toBe('1');
  });

  it("the host's only window renders animation frames (measured everywhere, asserted on Linux)", async () => {
    world = await templateWorld('standard');
    const page = pageOf(await world.launch('alpha'));
    await page.goto(world.sites.url('site-a.test'));
    const frames = await page.evaluate(
      () =>
        new Promise<number>((resolve) => {
          let n = 0;
          const t0 = performance.now();
          const tick = () => {
            n += 1;
            if (performance.now() - t0 < 1_000) requestAnimationFrame(tick);
            else resolve(n);
          };
          requestAnimationFrame(tick);
        }),
    );
    process.stderr.write(`animation frames in 1 s of the host's only window: ${frames}\n`);
    // macOS and Windows render a never-activated lone background window slowly (deferred D68).
    if (LINUX) expect(frames).toBeGreaterThanOrEqual(20);
  });

  it("a site's popup closing itself as the browser's last window does not stop it (review #91 M1)", async () => {
    world = await templateWorld('standard');
    const w = world;
    const alpha = await w.launch('alpha');
    await pageOf(alpha).goto(w.sites.url('site-a.test'));
    const popupOpened = w.host().context.waitForEvent('page');
    await pageOf(alpha).click('#popup-window');
    const popup = await popupOpened;
    await until(() => alpha.tabs.size() === 2, 5_000, 'the popup in the session');
    const first = alpha.tabs.entries().find(([, page]) => page === pageOf(alpha))?.[0];
    if (first === undefined) throw new Error('no first tab');
    await w.sessions.closeTab(alpha, first);
    // The site's own script closes its popup (allowed: a script opened it).
    await popup.evaluate(() => window.close()).catch(() => undefined);
    await until(() => popup.isClosed(), 5_000, 'the popup closed');
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    expect(w.supervisor.host(w.template.templateId).state).toBe('running');
    expect(alpha.closedReason).toBeNull();
  });

  it.if(HEADED)(
    "the operator closing the last window is a stop even when an agent's close_tab lands just after (review #91 L1)",
    async () => {
      world = await templateWorld('standard');
      const w = world;
      const alpha = await w.launch('alpha');
      const bravo = await w.launch('bravo');
      await closeByHand(pageOf(bravo));
      const tab = alpha.tabs.activeTabId();
      if (tab === undefined) throw new Error('no tab');
      await w.sessions.closeTab(alpha, tab);
      const id = w.template.templateId;
      await until(() => w.supervisor.host(id).state === 'stopped', 15_000, 'the operator stop');
    },
  );

  it("a site closing an agent's new_tab tab, the browser's last window, does not stop it (verify #91 N1)", async () => {
    world = await templateWorld('standard', { template: { agentWindows: 'normal' } });
    const w = world;
    const alpha = await w.launch('alpha');
    const bravo = await w.launch('bravo');
    await pageOf(alpha).goto(w.sites.url('site-a.test'));
    const { tabId, page: tab } = await w.sessions.newTab(alpha);
    await tab.goto(w.sites.url('site-b.test', '/landing'));
    const first = alpha.tabs.entries().find(([id]) => id !== tabId)?.[0];
    if (first === undefined) throw new Error('no first tab');
    await w.sessions.closeTab(alpha, first);
    await w.sessions.close(bravo.id);
    // The site's own script closes the tab (Chrome allows it: `new_tab` opened it with window.open).
    await tab.evaluate(() => window.close()).catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    expect(w.supervisor.host(w.template.templateId).state).toBe('running');
    expect(alpha.closedReason).toBeNull();
  });

  it('the sign-in window closed by hand leaves the browser up with no window', async () => {
    world = await templateWorld('standard');
    const signIn = await world.supervisor.launchMaintenance({
      template: world.template,
      sites: [templateSiteRecord()],
      slug: 'recording',
      principal: { subject: 'operator' },
      recording: true,
    });
    await closeByHand(pageOf(signIn));
    await until(() => pageOf(signIn).isClosed(), 5_000, 'the sign-in window closed');
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    expect(world.supervisor.host(world.template.templateId).state).toBe('running');
    expect(signIn.closedReason).toBeNull();
    // The sign-in can go on: a new window opens on the same browser.
    const alpha = await world.launch('alpha');
    expect(alpha.view).not.toBeNull();
    expect(world.hosts).toHaveLength(1);
  });
});

describe.if(WM)('template host with no window (window manager)', () => {
  it("a checkpoint never moves the operator's focus or raises an agent window", async () => {
    world = await templateWorld('standard', { template: { agentWindows: 'normal' } });
    const alpha = await world.launch('alpha');
    const page = pageOf(alpha);
    // An origin with storage and no open page: Playwright opens a page of its own to read it.
    await page.goto(world.sites.url('site-b.test'));
    await page.evaluate(() => localStorage.setItem('bh-ckpt', 'kept'));
    await page.goto(world.sites.url('site-a.test'));
    const operator = operatorWindow();
    try {
      const desktop = watchDesktop();
      const state = await world.host().storageState();
      const seen = await desktop.stop();
      expect([...seen.foci]).toEqual([operator?.id ?? '']);
      const siteB = state.origins.find((o) => o.origin === 'https://site-b.test');
      expect(siteB?.localStorage).toEqual([{ name: 'bh-ckpt', value: 'kept' }]);
      // The agent's window kept its one tab, on its page.
      expect(alpha.tabs.size()).toBe(1);
      expect(page.url()).toBe('https://site-a.test/');
    } finally {
      operator?.close();
    }
  });

  it("the browser menu's Exit stops the browser like closing its last window", async () => {
    world = await templateWorld('standard', { template: { agentWindows: 'normal' } });
    const w = world;
    const alpha = await w.launch('alpha');
    const bravo = await w.launch('bravo');
    const title = 'bh-exit-window';
    await pageOf(alpha).evaluate((t) => {
      document.title = t;
    }, title);
    let id = '';
    await until(
      () => {
        id = sh('xdotool', ['search', '--name', title]).split('\n')[0] ?? '';
        return id !== '';
      },
      5_000,
      'the window by its title',
    );
    // The operator brings the window up and picks Exit in Chrome's menu (Alt+F, then X).
    spawnSync('xdotool', ['windowactivate', '--sync', id], { timeout: 10_000 });
    await new Promise((resolve) => setTimeout(resolve, 300));
    spawnSync('xdotool', ['key', 'alt+f']);
    await new Promise((resolve) => setTimeout(resolve, 600));
    spawnSync('xdotool', ['key', 'x']);
    const templateId = w.template.templateId;
    await until(() => w.supervisor.host(templateId).state === 'stopped', 15_000, 'the stop');
    expect(alpha.closedReason).toBe('operator');
    expect(bravo.closedReason).toBe('operator');
  });
});

/** A loopback port nothing listens on (the proxy of the argv check is never contacted). */
async function closedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  if (address === null || typeof address === 'string') throw new Error('no port');
  return address.port;
}

/** The command line of a running browser, without the executable (Linux `/proc`). */
async function commandLine(context: BrowserContext): Promise<string[]> {
  const pid = await readBrowserPid(context.browser(), createCollectingLogger());
  if (pid === null) throw new Error('no browser pid');
  const raw = readFileSync(`/proc/${pid}/cmdline`, 'utf8');
  // Chromium may rewrite its process title into one space-joined string (seen on Linux 7.0).
  const parts = raw.split('\0').filter(Boolean);
  return (parts.length > 1 ? parts : raw.trim().split(' ').filter(Boolean)).slice(1);
}

describe.if(LINUX)("a host's real command line (D-78)", () => {
  const cases: { channel: Channel; stealth: boolean; proxy: boolean; headless: boolean }[] = [
    { channel: 'chromium', stealth: true, proxy: false, headless: true },
    { channel: 'chromium', stealth: false, proxy: true, headless: true },
    ...(HEADED
      ? [{ channel: 'chromium' as const, stealth: true, proxy: true, headless: false }]
      : []),
    ...(playwrightExecutable('chrome') !== null
      ? [{ channel: 'chrome' as const, stealth: true, proxy: true, headless: true }]
      : []),
  ];
  for (const c of cases) {
    it(`is the previous launch's with --no-startup-window for about:blank: ${c.channel} ${c.headless ? 'headless' : 'headed'} stealth ${c.stealth ? 'on' : 'off'}${c.proxy ? ' proxy' : ''}`, async () => {
      const dir = await mkdtemp(join(tmpdir(), 'bh-argv-'));
      const proxy: ProxySpec | null = c.proxy
        ? { server: `http://127.0.0.1:${await closedPort()}`, label: 'test' }
        : null;
      const spec: TemplateHostSpec = {
        templateId: 'tp-argv',
        channel: c.channel,
        headless: c.headless,
        stealth: c.stealth,
        fingerprint: false,
        userDataDir: join(dir, 'userdata'),
        downloadsDir: join(dir, 'downloads'),
        identity: {
          seed: 'seed',
          geo: {
            locale: 'en-US',
            languages: ['en-US'],
            countryCode: null,
            timezoneId: 'UTC',
            source: 'host',
          },
        },
        proxy,
        window: { width: 1280, height: 800 },
        selfOrigins: [],
        testingArgs: [],
      };
      const fingerprint = deriveFingerprint({ seed: 'seed', hostPlatform: 'linux' });
      const options = hostLaunchOptions(
        spec,
        contextOptionsFor(fingerprint, spec.identity.geo, false),
        false,
      );
      try {
        // Before D-78: the driver's own argv (its first page at about:blank).
        const previous = await chromium.launchPersistentContext(spec.userDataDir, options);
        const before = await commandLine(previous);
        expect(previous.pages()).toHaveLength(1);
        await previous.close();
        const args = await hostArgv(options, spec.userDataDir, { proxy, sandboxed: false });
        const now = await chromium.launchPersistentContext(spec.userDataDir, {
          ...options,
          ignoreDefaultArgs: true,
          args,
        });
        const after = await commandLine(now);
        expect(now.pages()).toHaveLength(0);
        await now.close();
        expect(before.at(-1)).toBe('about:blank');
        expect(after).toEqual([...before.slice(0, -1), '--no-startup-window']);
        if (proxy !== null) expect(after).toContain(`--proxy-server=${proxy.server}`);
      } finally {
        await removeTree(dir).catch(() => undefined);
      }
    });
  }
});
