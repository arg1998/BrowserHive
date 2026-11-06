/** @module sw/sw.test — the worker's event handlers and the kill switch in a fake global scope: in-memory CacheStorage, scripted fetch, fake timers (04 §18.5, 09 §3.5) */
import { beforeEach, describe, expect, it } from 'bun:test';
import { startKillSwitch } from './kill-switch.ts';
import type { WorkerExtendableEvent, WorkerFetchEvent, WorkerScope } from './scope.ts';
import { startWorker, type WorkerConstants } from './sw.ts';

const ORIGIN = 'http://127.0.0.1:9876';
const MARKER = 'x-browserhive-version';
const CONSTANTS: WorkerConstants = {
  version: '0123456789ab',
  precache: ['/offline.html', '/assets/offline-Ab12.js', '/assets/offline-offline-Cd34.css'],
  navigationTimeoutMs: 10_000,
  markerHeader: MARKER,
};
const CACHE = 'bh-offline-0123456789ab';

interface ResponseShape {
  readonly status?: number;
  readonly marked?: boolean;
  readonly contentType?: string;
  readonly type?: string;
  readonly redirected?: boolean;
  readonly body?: string;
}

/** A real `Response` with the members a browser sets (type, redirected, status 0) overridden. */
function response(shape: ResponseShape = {}): Response {
  const headers = new Headers();
  if (shape.marked ?? true) headers.set(MARKER, '1.2.3');
  if (shape.contentType !== undefined) headers.set('content-type', shape.contentType);
  const status = shape.status ?? 200;
  const res = new Response(shape.body ?? 'body', {
    status: status === 0 ? 200 : status,
    headers,
  });
  Object.defineProperty(res, 'type', { value: shape.type ?? 'basic' });
  Object.defineProperty(res, 'redirected', { value: shape.redirected ?? false });
  if (status === 0) {
    Object.defineProperty(res, 'status', { value: 0 });
    Object.defineProperty(res, 'ok', { value: false });
  }
  return res;
}

function keyOf(request: Request | string): string {
  return typeof request === 'string' ? request : request.url;
}

class FakeCache {
  readonly entries = new Map<string, Response>();
  async put(request: Request | string, res: Response): Promise<void> {
    this.entries.set(keyOf(request), res);
  }
}

class FakeCaches {
  readonly stores = new Map<string, FakeCache>();
  readonly matches: { key: string; options: unknown }[] = [];
  async open(name: string): Promise<FakeCache> {
    const existing = this.stores.get(name);
    if (existing !== undefined) return existing;
    const created = new FakeCache();
    this.stores.set(name, created);
    return created;
  }
  async keys(): Promise<string[]> {
    return [...this.stores.keys()];
  }
  async delete(name: string): Promise<boolean> {
    return this.stores.delete(name);
  }
  async match(
    request: Request | string,
    options: { readonly cacheName: string; readonly ignoreVary: boolean },
  ): Promise<Response | undefined> {
    this.matches.push({ key: keyOf(request), options });
    return this.stores.get(options.cacheName)?.entries.get(keyOf(request));
  }
}

class FakeTimers {
  private next = 1;
  readonly pending = new Map<number, () => void>();
  readonly cleared: number[] = [];
  readonly delays: number[] = [];
  setTimeout(fn: () => void, ms: number): number {
    const id = this.next++;
    this.pending.set(id, fn);
    this.delays.push(ms);
    return id;
  }
  clearTimeout(id: number): void {
    this.cleared.push(id);
    this.pending.delete(id);
  }
  fireAll(): void {
    const due = [...this.pending.entries()];
    this.pending.clear();
    for (const [, fn] of due) fn();
  }
}

type Listener = (event: never) => void;

interface Harness {
  readonly scope: WorkerScope;
  readonly caches: FakeCaches;
  readonly timers: FakeTimers;
  readonly fetchCalls: unknown[][];
  readonly listeners: Map<string, Listener>;
  readonly log: string[];
  fetchImpl: (...args: unknown[]) => Promise<Response>;
}

function harness(): Harness {
  const caches = new FakeCaches();
  const timers = new FakeTimers();
  const listeners = new Map<string, Listener>();
  const log: string[] = [];
  const h: Harness = {
    caches,
    timers,
    listeners,
    log,
    fetchCalls: [],
    fetchImpl: () => Promise.reject(new TypeError('Failed to fetch')),
    scope: {
      location: { origin: ORIGIN },
      caches,
      registration: {
        unregister: async () => {
          log.push('unregister');
          return true;
        },
      },
      clients: {
        claim: async () => {
          log.push('claim');
        },
      },
      fetch: (...args: unknown[]) => {
        h.fetchCalls.push(args);
        return h.fetchImpl(...args);
      },
      skipWaiting: async () => {
        log.push('skipWaiting');
      },
      setTimeout: (fn, ms) => timers.setTimeout(fn, ms),
      clearTimeout: (id) => timers.clearTimeout(id),
      addEventListener: (type: string, listener: Listener) => {
        listeners.set(type, listener);
      },
    } as WorkerScope,
  };
  return h;
}

function extendable(): WorkerExtendableEvent & { readonly promises: Promise<unknown>[] } {
  const promises: Promise<unknown>[] = [];
  return { promises, waitUntil: (promise) => promises.push(promise) };
}

interface FakeFetchEvent extends WorkerFetchEvent {
  readonly promises: Promise<unknown>[];
  responded: Promise<Response> | null;
}

/** A request as the browser builds it; `mode: 'navigate'` cannot be constructed with `new Request`. */
function request(path: string, mode = 'navigate', method = 'GET'): Request {
  return { url: `${ORIGIN}${path}`, mode, method } as Request;
}

function fetchEvent(req: Request): FakeFetchEvent {
  const base = extendable();
  const event: FakeFetchEvent = {
    ...base,
    request: req,
    responded: null,
    respondWith: (res) => {
      event.responded = res;
    },
  };
  return event;
}

function dispatch(h: Harness, type: 'install' | 'activate'): Promise<unknown[]> {
  const event = extendable();
  const listener = h.listeners.get(type) as ((e: WorkerExtendableEvent) => void) | undefined;
  listener?.(event);
  return Promise.all(event.promises);
}

function dispatchFetch(h: Harness, req: Request): FakeFetchEvent {
  const event = fetchEvent(req);
  const listener = h.listeners.get('fetch') as ((e: WorkerFetchEvent) => void) | undefined;
  listener?.(event);
  return event;
}

async function seedCache(h: Harness, name = CACHE): Promise<FakeCache> {
  const cache = await h.caches.open(name);
  cache.entries.set(`${ORIGIN}/offline.html`, response({ body: 'offline page' }));
  cache.entries.set(`${ORIGIN}/assets/offline-Ab12.js`, response({ body: 'js' }));
  return cache;
}

/** Lets pending promise callbacks run. */
async function flush(): Promise<void> {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
}

describe('service worker: install', () => {
  let h: Harness;
  beforeEach(() => {
    h = harness();
    startWorker(h.scope, CONSTANTS);
  });

  it('fetches every precache path with cache: reload, stores them, then skips waiting', async () => {
    h.fetchImpl = async () => response();
    await dispatch(h, 'install');
    expect(h.fetchCalls).toEqual(
      CONSTANTS.precache.map((path) => [
        `${ORIGIN}${path}`,
        { cache: 'reload', credentials: 'same-origin' },
      ]),
    );
    expect([...(h.caches.stores.get(CACHE)?.entries.keys() ?? [])]).toEqual(
      CONSTANTS.precache.map((path) => `${ORIGIN}${path}`),
    );
    expect(h.log).toEqual(['skipWaiting']);
  });

  const bad: [string, ResponseShape][] = [
    ['not ok', { status: 404 }],
    ['redirected', { redirected: true }],
    ['not basic', { type: 'opaque' }],
    ['unmarked', { marked: false }],
  ];
  it.each(bad)('rejects and stores nothing when one response is %s', async (_name, shape) => {
    h.fetchImpl = async (input) => (String(input).endsWith('.css') ? response(shape) : response());
    await expect(dispatch(h, 'install')).rejects.toThrow('precache');
    expect(h.caches.stores.get(CACHE)?.entries.size ?? 0).toBe(0);
    expect(h.log).toEqual([]);
  });

  it('rejects when a fetch fails (a daemon without --admin, nothing listening)', async () => {
    await expect(dispatch(h, 'install')).rejects.toThrow('Failed to fetch');
    expect(h.log).toEqual([]);
  });
});

describe('service worker: activate', () => {
  it('deletes only stale bh-offline-* caches, then claims the pages', async () => {
    const h = harness();
    startWorker(h.scope, CONSTANTS);
    for (const name of ['bh-offline-old111111111', CACHE, 'trace-viewer', 'bh-other']) {
      await h.caches.open(name);
    }
    await dispatch(h, 'activate');
    expect(await h.caches.keys()).toEqual([CACHE, 'trace-viewer', 'bh-other']);
    expect(h.log).toEqual(['claim']);
  });
});

describe('service worker: fetch', () => {
  let h: Harness;
  beforeEach(async () => {
    h = harness();
    startWorker(h.scope, CONSTANTS);
    await seedCache(h);
  });

  it('never answers a request routed pass', () => {
    for (const req of [
      request('/sessions', 'navigate', 'POST'),
      request('/api/v1/sessions', 'navigate'),
      request('/health', 'cors'),
      request('/sw.js', 'same-origin'),
      request('/manifest.webmanifest', 'cors'),
      request('/assets/index-XYZ.js', 'cors'),
    ]) {
      expect(dispatchFetch(h, req).responded).toBeNull();
    }
    expect(h.fetchCalls).toEqual([]);
  });

  it('calls fetch with the original Request object and no init argument', async () => {
    const marked = response({ contentType: 'text/html' });
    h.fetchImpl = async () => marked;
    const req = request('/sessions');
    const event = dispatchFetch(h, req);
    expect(await event.responded).toBe(marked);
    expect(h.fetchCalls).toHaveLength(1);
    expect(h.fetchCalls[0]).toHaveLength(1);
    expect(h.fetchCalls[0]?.[0]).toBe(req);
  });

  it('starts the 10 s timer and clears it as soon as the network answers', async () => {
    h.fetchImpl = async () => response();
    await dispatchFetch(h, request('/sessions')).responded;
    expect(h.timers.delays).toEqual([10_000]);
    expect(h.timers.cleared).toEqual([1]);
    expect(h.timers.pending.size).toBe(0);
  });

  it('clears the timer when the fetch rejects, and serves the cached offline page', async () => {
    const res = await dispatchFetch(h, request('/sessions')).responded;
    expect(await res?.text()).toBe('offline page');
    expect(h.timers.cleared).toEqual([1]);
    expect(h.timers.pending.size).toBe(0);
    expect(h.caches.matches.at(-1)).toEqual({
      key: `${ORIGIN}/offline.html`,
      options: { cacheName: CACHE, ignoreVary: true },
    });
  });

  it('serves the offline page when the timer fires first, and drops the late answer', async () => {
    let answer: (res: Response) => void = () => undefined;
    h.fetchImpl = () =>
      new Promise((resolve) => {
        answer = resolve;
      });
    const event = dispatchFetch(h, request('/sessions'));
    await flush();
    h.timers.fireAll();
    const res = await event.responded;
    expect(await res?.text()).toBe('offline page');
    let cancelled = false;
    const late = {
      status: 200,
      headers: new Headers(),
      body: {
        cancel: async () => {
          cancelled = true;
        },
      },
    } as unknown as Response;
    answer(late);
    await flush();
    expect(cancelled).toBe(true);
    expect(h.timers.cleared).toEqual([]);
  });

  it('returns a marked response untouched, whatever its status', async () => {
    for (const status of [200, 404, 421, 500, 503]) {
      const marked = response({ status, contentType: 'text/html' });
      h.fetchImpl = async () => marked;
      expect(await dispatchFetch(h, request('/sessions')).responded).toBe(marked);
    }
  });

  it('serves the offline page for an unmarked 5xx (a proxy whose upstream is down)', async () => {
    h.fetchImpl = async () => response({ status: 502, marked: false, contentType: 'text/html' });
    const res = await dispatchFetch(h, request('/sessions')).responded;
    expect(await res?.text()).toBe('offline page');
  });

  it('returns an unmarked 404 or opaque redirect untouched, without retiring', async () => {
    for (const shape of [
      { status: 404, marked: false, contentType: 'text/html' },
      { status: 0, marked: false, type: 'opaqueredirect' },
    ]) {
      const res = response(shape);
      h.fetchImpl = async () => res;
      const event = dispatchFetch(h, request('/sessions'));
      expect(await event.responded).toBe(res);
      expect(event.promises).toEqual([]);
    }
    expect(h.log).toEqual([]);
  });

  it('retires under waitUntil on an unmarked 2xx HTML page, returning it untouched', async () => {
    await h.caches.open('bh-offline-old111111111');
    await h.caches.open('trace-viewer');
    const foreign = response({ marked: false, contentType: 'text/html; charset=utf-8' });
    h.fetchImpl = async () => foreign;
    const event = dispatchFetch(h, request('/'));
    expect(await event.responded).toBe(foreign);
    expect(event.promises).toHaveLength(1);
    await Promise.all(event.promises);
    expect(await h.caches.keys()).toEqual(['trace-viewer']);
    expect(h.log).toEqual(['unregister']);
  });

  it('serves a precached asset cache-first with ignoreVary', async () => {
    const req = request('/assets/offline-Ab12.js', 'no-cors');
    const res = await dispatchFetch(h, req).responded;
    expect(await res?.text()).toBe('js');
    expect(h.caches.matches).toEqual([
      { key: req.url, options: { cacheName: CACHE, ignoreVary: true } },
    ]);
    expect(h.fetchCalls).toEqual([]);
  });

  it('fetches a precached asset missing from the cache', async () => {
    const network = response({ body: 'css' });
    h.fetchImpl = async () => network;
    const req = request('/assets/offline-offline-Cd34.css', 'no-cors');
    expect(await dispatchFetch(h, req).responded).toBe(network);
    expect(h.fetchCalls).toEqual([[req]]);
  });

  it('answers Response.error() when the offline page is not cached', async () => {
    h.caches.stores.clear();
    const res = await dispatchFetch(h, request('/sessions')).responded;
    expect(res?.type).toBe('error');
  });
});

describe('kill switch', () => {
  it('has no fetch listener; install skips waiting', async () => {
    const h = harness();
    startKillSwitch(h.scope);
    expect([...h.listeners.keys()].sort()).toEqual(['activate', 'install']);
    await dispatch(h, 'install');
    expect(h.log).toEqual(['skipWaiting']);
  });

  it('activate deletes its caches, unregisters, then claims', async () => {
    const h = harness();
    startKillSwitch(h.scope);
    for (const name of ['bh-offline-aaa', 'bh-offline-bbb', 'trace-viewer']) {
      await h.caches.open(name);
    }
    await dispatch(h, 'activate');
    expect(await h.caches.keys()).toEqual(['trace-viewer']);
    expect(h.log).toEqual(['unregister', 'claim']);
  });
});
