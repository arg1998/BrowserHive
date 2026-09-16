/** @module test/integration/isolation — two sessions never share cookies, localStorage, sessionStorage, IndexedDB or service workers (the project's core guarantee). */

import { describe, expect, it } from 'bun:test';
import { useDriverFixtures } from './driver-fixture.ts';

/** What `/storage` renders into `#storage` after `window.__setStorage`. */
interface StorageView {
  local: string | null;
  session: string | null;
  cookie: string;
}

describe('session isolation', () => {
  const { state } = useDriverFixtures();

  async function storageView(page: Awaited<ReturnType<typeof state.launch>>['page']) {
    await page.reload();
    const text = await page.locator('#storage').textContent();
    return JSON.parse(text ?? '{}') as StorageView;
  }

  it('cookies do not leak between sessions (set by the server and by the page)', async () => {
    const a = await state.launch({ slug: 'sessa' });
    const b = await state.launch({ slug: 'sessb' });
    await a.page.goto(state.fixture.url('/set-cookie?v=from_A'));
    await b.page.goto(state.fixture.url('/'));

    const cookiesA = new Map((await a.handle.context.cookies()).map((c) => [c.name, c.value]));
    const cookiesB = new Map((await b.handle.context.cookies()).map((c) => [c.name, c.value]));
    expect(cookiesA.get('fixture')).toBe('from_A');
    expect(cookiesB.has('fixture')).toBe(false);

    // The wire must agree: B's next request carries no cookie header.
    await b.page.goto(state.fixture.url('/echo-headers'));
    const echoed = state.fixture.requests.filter((r) => r.path === '/echo-headers');
    expect(echoed[echoed.length - 1]?.headers['cookie']).toBeUndefined();
  });

  it('localStorage, sessionStorage and document.cookie do not leak between sessions', async () => {
    const a = await state.launch({ slug: 'sessa' });
    const b = await state.launch({ slug: 'sessb' });
    await a.page.goto(state.fixture.url('/storage'));
    await b.page.goto(state.fixture.url('/storage'));
    await a.page.evaluate(() =>
      (window as unknown as { __setStorage(v: string): void }).__setStorage('from_A'),
    );

    const fromA = await storageView(a.page);
    const fromB = await storageView(b.page);
    expect(fromA).toEqual({ local: 'from_A', session: 'from_A', cookie: 'bh-fixture=from_A' });
    expect(fromB).toEqual({ local: null, session: null, cookie: '' });
  });

  it('IndexedDB does not leak between sessions', async () => {
    const a = await state.launch({ slug: 'sessa' });
    const b = await state.launch({ slug: 'sessb' });
    await a.page.goto(state.fixture.url('/storage'));
    await b.page.goto(state.fixture.url('/storage'));

    await a.page.evaluate(
      () =>
        new Promise<void>((resolve, reject) => {
          const req = indexedDB.open('canary-db', 1);
          req.onupgradeneeded = () => {
            req.result.createObjectStore('items', { keyPath: 'id' });
          };
          req.onsuccess = () => {
            const db = req.result;
            const tx = db.transaction('items', 'readwrite');
            tx.objectStore('items').put({ id: 1, value: 'from_A' });
            tx.oncomplete = () => {
              db.close();
              resolve();
            };
            tx.onerror = () => reject(tx.error);
          };
          req.onerror = () => reject(req.error);
        }),
    );

    const read = (page: typeof a.page) =>
      page.evaluate(
        () =>
          new Promise<string | null>((resolve, reject) => {
            const req = indexedDB.open('canary-db', 1);
            req.onupgradeneeded = () => {
              req.result.createObjectStore('items', { keyPath: 'id' });
            };
            req.onsuccess = () => {
              const db = req.result;
              const tx = db.transaction('items', 'readonly');
              const get = tx.objectStore('items').get(1);
              get.onsuccess = () => {
                db.close();
                const row: unknown = get.result;
                resolve(
                  typeof row === 'object' && row !== null && 'value' in row
                    ? String(row.value)
                    : null,
                );
              };
              get.onerror = () => reject(get.error);
            };
            req.onerror = () => reject(req.error);
          }),
      );
    expect(await read(a.page)).toBe('from_A');
    // If A's data leaked, the store and its row would already exist before any write in B.
    expect(await read(b.page)).toBeNull();
  });

  it('ServiceWorker registrations do not leak between sessions', async () => {
    const a = await state.launch({ slug: 'sessa' });
    const b = await state.launch({ slug: 'sessb' });
    await a.page.goto(state.fixture.url('/sw'));
    await b.page.goto(state.fixture.url('/'));
    await a.page.waitForFunction(
      () => (window as unknown as { __swReady?: boolean }).__swReady === true,
    );
    await a.page.evaluate(() => navigator.serviceWorker.ready);

    const aRegs = await a.page.evaluate(async () => {
      const regs = await navigator.serviceWorker.getRegistrations();
      return regs.length;
    });
    expect(aRegs).toBeGreaterThanOrEqual(1);
    const bRegs = await b.page.evaluate(async () => {
      const regs = await navigator.serviceWorker.getRegistrations();
      return regs.length;
    });
    expect(bRegs).toBe(0);
  });

  it('each session is its own browser process and context', async () => {
    const a = await state.launch({ slug: 'sessa' });
    const b = await state.launch({ slug: 'sessb' });
    expect(a.handle.browser).not.toBe(b.handle.browser);
    expect(a.handle.context).not.toBe(b.handle.context);
    await a.page.goto('data:text/html,<title>AAA</title>');
    await b.page.goto('data:text/html,<title>BBB</title>');
    expect(await a.page.title()).toBe('AAA');
    expect(await b.page.title()).toBe('BBB');
  });

  it('closing one session leaves the other alive and reports no crash', async () => {
    const a = await state.launch({ slug: 'sessa' });
    const b = await state.launch({ slug: 'sessb' });
    const crashes: string[] = [];
    b.handle.onCrash((reason) => crashes.push(reason));
    const warnings = await a.handle.close(10_000);
    expect(warnings).toEqual([]);
    await b.page.goto(state.fixture.url('/'));
    expect(await b.page.locator('#title').textContent()).toBe('fixture');
    expect(crashes).toEqual([]);
  });
});
