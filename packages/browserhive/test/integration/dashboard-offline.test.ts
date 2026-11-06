/** @module test/integration/dashboard-offline.test — the installed dashboard's service worker and offline page against a real daemon, a hung port, a failing proxy, a daemon without --admin, the daemon-unreachable banner and a foreign server on the same port (spec 09 §3.4, 04 §18, D-49). Needs the built dashboard. */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { NON_SPA_PREFIXES } from '@browserhive/contracts/paths';
import { type Browser, type BrowserContext, chromium, type Page } from 'playwright';
import { type BootOverrides, bootServer, type RunningServer } from '../../src/composition/index.ts';
import { bootInputFor, tempDir } from '../composition/support.ts';

const DASHBOARD_DIST = join(import.meta.dir, '../../../dashboard/dist');
const STEP_TIMEOUT_MS = 60_000;
/** How long the `ready` phase is held in the starting step (09 §3.4 step 4). */
const READY_HOLD_MS = 4_000;

interface RecordedRequest {
  readonly method: string;
  readonly path: string;
  readonly headers: Readonly<Record<string, string>>;
}

type Serve = NonNullable<BootOverrides['serve']>;

let dir: ReturnType<typeof tempDir>;
let port = 0;
let base = '';
let browser: Browser;
let context: BrowserContext;
let page: Page;
let server: RunningServer | null = null;
let impostor: { stop(): void } | null = null;
const recorded: RecordedRequest[] = [];
/** Responses to reserved paths that the worker answered: there must be none (04 §18.5.5). */
const answeredByWorker: string[] = [];

/** `Bun.serve` that records every request the daemon receives. */
const recordingServe: Serve = (options) =>
  Bun.serve({
    hostname: options.hostname,
    port: options.port,
    fetch: (request, bunServer) => {
      const url = new URL(request.url);
      recorded.push({
        method: request.method,
        path: url.pathname,
        headers: Object.fromEntries(request.headers),
      });
      return options.fetch(request, bunServer);
    },
    websocket: options.websocket,
  });

/** A free TCP port other than the daemon's default. */
function freePort(): number {
  for (;;) {
    const probe = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('') });
    const found = probe.port ?? 0;
    probe.stop(true);
    if (found !== 9876 && found !== 0) return found;
  }
}

/** Retries `bind` while the port is still held (EADDRINUSE), for up to 5 s. */
async function rebinding<T>(bind: () => T | Promise<T>): Promise<T> {
  const deadline = Date.now() + 5_000;
  for (;;) {
    try {
      return await bind();
    } catch (error) {
      const text = `${(error as { code?: unknown }).code ?? ''} ${String(error)}`;
      if (Date.now() > deadline || !/EADDRINUSE|PORT_IN_USE|in use/i.test(text)) throw error;
      await Bun.sleep(100);
    }
  }
}

async function bootDaemon(admin: boolean, overrides: BootOverrides = {}): Promise<RunningServer> {
  return rebinding(() =>
    bootServer(bootInputFor(dir.path, { admin, port, host: '127.0.0.1' }), {
      serve: recordingServe,
      ...overrides,
    }),
  );
}

async function stopEverything(): Promise<void> {
  if (server !== null) await server.stop();
  server = null;
  impostor?.stop();
  impostor = null;
  // Wait until the port refuses.
  for (let i = 0; i < 100; i += 1) {
    try {
      await fetch(`${base}/health`, { signal: AbortSignal.timeout(500) });
    } catch {
      return;
    }
    await Bun.sleep(50);
  }
  throw new Error(`port ${port} still answers`);
}

const JSON_HEADERS = () => ({ 'content-type': 'application/json', origin: base });

/** The `name=value` pairs a response sets. */
function setCookies(response: Response): { name: string; value: string }[] {
  return response.headers.getSetCookie().map((line) => {
    const pair = line.split(';')[0] ?? '';
    const at = pair.indexOf('=');
    return { name: pair.slice(0, at), value: pair.slice(at + 1) };
  });
}

function cookieHeader(cookies: readonly { name: string; value: string }[]): string {
  return cookies.map((c) => `${c.name}=${c.value}`).join('; ');
}

/** `POST /api/v1/auth/login`; returns the session cookies. */
async function restLogin(password: string): Promise<{ name: string; value: string }[]> {
  const response = await fetch(`${base}/api/v1/auth/login`, {
    method: 'POST',
    headers: JSON_HEADERS(),
    body: JSON.stringify({ password }),
  });
  if (!response.ok) throw new Error(`login: HTTP ${response.status} ${await response.text()}`);
  return setCookies(response);
}

/** Waits until the page's `h1` matches (the page is driven from Node: this package has no DOM types). */
async function waitForHeading(pattern: RegExp, timeout: number): Promise<string> {
  const deadline = Date.now() + timeout;
  let text = '';
  for (;;) {
    text =
      (await page
        .locator('h1')
        .first()
        .textContent({ timeout })
        .catch(() => '')) ?? '';
    if (pattern.test(text)) return text;
    if (Date.now() > deadline) throw new Error(`h1 is "${text}", expected ${pattern}`);
    await Bun.sleep(100);
  }
}

/** The page's worker registrations and `bh-offline-*` caches. */
function workerState(): Promise<{ registrations: number; caches: string[] }> {
  return page.evaluate(`(async () => ({
    registrations: (await navigator.serviceWorker.getRegistrations()).length,
    caches: (await caches.keys()).filter((name) => name.startsWith('bh-offline-')),
  }))()`);
}

beforeAll(async () => {
  if (!existsSync(join(DASHBOARD_DIST, 'sw.js'))) {
    throw new Error(
      'packages/dashboard/dist/sw.js is missing: run `bun run build` first (or `bun run --filter @browserhive/dashboard build`)',
    );
  }
  dir = tempDir('bh-offline-');
  port = freePort();
  base = `http://127.0.0.1:${port}`;
  server = await bootDaemon(true);
  browser = await chromium.launch();
  context = await browser.newContext({ serviceWorkers: 'allow' });
  page = await context.newPage();
  page.on('response', (response) => {
    const path = new URL(response.url()).pathname;
    const reserved = NON_SPA_PREFIXES.some((p) => path === p || path.startsWith(`${p}/`));
    if (reserved && response.fromServiceWorker()) answeredByWorker.push(path);
  });
});

afterAll(async () => {
  await browser?.close();
  if (server !== null) await server.stop();
  impostor?.stop();
  dir?.cleanup();
});

describe('installed dashboard: service worker and offline page (D-49)', () => {
  it(
    '1. the worker installs and precaches the offline page',
    async () => {
      await page.goto(`${base}/login`);
      // Polled from Node: `waitForFunction` with a string would `eval` under the page's CSP.
      const deadline = Date.now() + 20_000;
      while (!(await page.evaluate<boolean>('navigator.serviceWorker.controller !== null'))) {
        if (Date.now() > deadline) throw new Error('the worker never took control');
        await Bun.sleep(100);
      }
      const precache = JSON.parse(
        readFileSync(join(DASHBOARD_DIST, 'sw-precache.json'), 'utf8'),
      ) as { version: string; paths: string[] };
      const cached: string[] = await page.evaluate(`(async () => {
        const cache = await caches.open('bh-offline-${precache.version}');
        return (await cache.keys()).map((request) => new URL(request.url).pathname).sort();
      })()`);
      expect(cached).toEqual([...precache.paths].sort());
      expect((await workerState()).caches).toEqual([`bh-offline-${precache.version}`]);
    },
    STEP_TIMEOUT_MS,
  );

  it(
    '2. navigations reach the daemon unchanged (Sec-Fetch-Mode: navigate)',
    async () => {
      recorded.length = 0;
      await page.goto(`${base}/sessions`);
      // A controlled page's in-scope navigation always goes through the worker's fetch handler.
      expect(await page.evaluate<boolean>('navigator.serviceWorker.controller !== null')).toBe(
        true,
      );
      const navigation = recorded.find((r) => r.method === 'GET' && r.path === '/sessions');
      expect(navigation?.headers['sec-fetch-mode']).toBe('navigate');
      // Chromium sends `Sec-Fetch-Dest: empty` for a worker's `fetch(event.request)` (measured
      // with Chromium 1243), so the mode is the signal the daemon's navigation check relies on.
      expect(['document', 'empty']).toContain(navigation?.headers['sec-fetch-dest'] ?? '');
    },
    STEP_TIMEOUT_MS,
  );

  it(
    '3. stopped: the offline page says it is not running, on the same URL',
    async () => {
      await stopEverything();
      await page.reload();
      await waitForHeading(/^BrowserHive isn't running$/, 10_000);
      expect(new URL(page.url()).pathname).toBe('/sessions');
      const commands = await page.locator('li code').allTextContents();
      expect(commands[0]).toBe(`browserhive --admin --port ${port}`);
      expect(answeredByWorker).toEqual([]);
    },
    STEP_TIMEOUT_MS,
  );

  it(
    '4. starting: shows BrowserHive is starting, then reloads into the dashboard',
    async () => {
      let listening: () => void = () => undefined;
      const listenerUp = new Promise<void>((resolve) => {
        listening = resolve;
      });
      const booting = bootDaemon(true, {
        phases: (defaults) =>
          defaults.map((phase) =>
            phase.name === 'ready'
              ? {
                  ...phase,
                  run: async (ctx) => {
                    listening();
                    await Bun.sleep(READY_HOLD_MS);
                    return phase.run(ctx);
                  },
                }
              : phase,
          ),
      });
      await listenerUp;
      await page.getByRole('button', { name: 'Retry now' }).click();
      await waitForHeading(/^BrowserHive is starting$/, READY_HOLD_MS);
      server = await booting;
      await page.waitForURL(/\/login$/, { timeout: 20_000 });
      expect(answeredByWorker).toEqual([]);
    },
    STEP_TIMEOUT_MS,
  );

  it(
    '5. a port that accepts and never answers: the offline page after 10 s, then not responding',
    async () => {
      await stopEverything();
      const hung = await rebinding(() =>
        Bun.listen({
          hostname: '127.0.0.1',
          port,
          socket: { data: () => undefined },
        }),
      );
      impostor = { stop: () => hung.stop(true) };
      const started = Date.now();
      await page.goto(`${base}/sessions`, { timeout: 20_000 });
      const elapsed = Date.now() - started;
      expect(elapsed).toBeGreaterThanOrEqual(9_500);
      expect(elapsed).toBeLessThan(14_000);
      expect(await page.locator('h1').textContent()).toBe(
        `Checking BrowserHive at 127.0.0.1:${port}…`,
      );
      expect(await page.locator('li code').count()).toBe(0);
      await waitForHeading(/^BrowserHive isn't responding$/, 8_000);
    },
    STEP_TIMEOUT_MS,
  );

  it(
    '6. a proxy whose upstream is down (unmarked 502): unreachable behind the address',
    async () => {
      await stopEverything();
      const proxy = await rebinding(() =>
        Bun.serve({
          hostname: '127.0.0.1',
          port,
          fetch: () =>
            new Response('<h1>502 Bad Gateway</h1>', {
              status: 502,
              headers: { 'content-type': 'text/html' },
            }),
        }),
      );
      impostor = { stop: () => proxy.stop(true) };
      await page.reload();
      await waitForHeading(/^BrowserHive is unreachable behind 127\.0\.0\.1:\d+$/, 10_000);
    },
    STEP_TIMEOUT_MS,
  );

  it(
    '7. a daemon without --admin: the status page, 404, through the worker',
    async () => {
      await stopEverything();
      server = await bootDaemon(false);
      const response = await page.goto(`${base}/sessions`);
      expect(response?.status()).toBe(404);
      expect(response?.headers()['content-type']).toContain('text/html');
      expect(await page.locator('body').textContent()).toContain('The dashboard is turned off.');
      expect(answeredByWorker).toEqual([]);
    },
    STEP_TIMEOUT_MS,
  );

  it(
    '8. the daemon-unreachable banner appears, explains, and clears without a reload',
    async () => {
      await stopEverything();
      server = await bootDaemon(true);
      // Sign in through REST: first-run password, the forced change, then the new password.
      const seed = readFileSync(join(dir.path, 'admin', 'credentials.txt'), 'utf8').trim();
      const rotated = `${seed}-rotated-step8`;
      const first = await restLogin(seed);
      const changed = await fetch(`${base}/api/v1/auth/change-password`, {
        method: 'POST',
        headers: { ...JSON_HEADERS(), cookie: cookieHeader(first) },
        body: JSON.stringify({ current_password: seed, new_password: rotated }),
      });
      expect(changed.status).toBeLessThan(300);
      const cookies = await restLogin(rotated);
      await context.addCookies(cookies.map((c) => ({ ...c, url: base })));
      await page.goto(`${base}/overview`);
      await page.getByRole('heading', { level: 1, name: 'Overview' }).waitFor({ timeout: 15_000 });
      await page.evaluate('window.__bhStep8 = "same document"');
      const banner = page.getByTestId('daemon-unreachable-banner');
      expect(await banner.count()).toBe(0);

      await stopEverything();
      await banner.waitFor({ state: 'visible', timeout: 30_000 });
      expect(await banner.textContent()).toContain(`Can't reach BrowserHive at 127.0.0.1:${port}.`);
      await banner.getByRole('button', { name: 'What to do' }).click();
      const dialog = page.getByRole('dialog');
      await dialog.waitFor({ timeout: 5_000 });
      expect(await dialog.locator('code').allTextContents()).toContain('browserhive doctor');
      await page.keyboard.press('Escape');
      await dialog.waitFor({ state: 'detached', timeout: 5_000 });

      server = await bootDaemon(true);
      await banner.waitFor({ state: 'detached', timeout: 15_000 });
      expect(await page.evaluate<string | undefined>('window.__bhStep8')).toBe('same document');
      expect(answeredByWorker).toEqual([]);
    },
    STEP_TIMEOUT_MS,
  );

  it(
    '9. another program answers HTML on the port: its page shows and the worker retires',
    async () => {
      await stopEverything();
      const foreign = await rebinding(() =>
        Bun.serve({
          hostname: '127.0.0.1',
          port,
          fetch: (request) =>
            new URL(request.url).pathname === '/'
              ? new Response('<!doctype html><title>Directory listing</title><h1>listing</h1>', {
                  headers: { 'content-type': 'text/html; charset=utf-8' },
                })
              : new Response('not found', { status: 404 }),
        }),
      );
      impostor = { stop: () => foreign.stop(true) };
      await page.goto(`${base}/`);
      expect(await page.locator('h1').textContent()).toBe('listing');
      const deadline = Date.now() + 10_000;
      let state = await workerState();
      while ((state.registrations > 0 || state.caches.length > 0) && Date.now() < deadline) {
        await Bun.sleep(200);
        state = await workerState();
      }
      expect(state).toEqual({ registrations: 0, caches: [] });
    },
    STEP_TIMEOUT_MS,
  );
});
