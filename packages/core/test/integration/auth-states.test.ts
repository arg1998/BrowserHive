/** @module test/integration/auth-states — save_storage_state / save_full_profile + restore through launch_session against real Chromium. */

import { describe, expect, it } from 'bun:test';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { unzipSync } from 'fflate';
import { PROFILE_CACHE_DIRS } from '../../src/app/auth-states/zip.ts';
import { LOCAL_PRINCIPAL } from '../../src/domain/auth/principal.ts';
import { textOf } from '../helpers/fake-transport.ts';
import { useMcpStack } from './mcp-fixture.ts';

describe('auth-state save + restore (real Chromium)', () => {
  const { state } = useMcpStack();

  const setItem = (key: string, value: string) =>
    `() => localStorage.setItem(${JSON.stringify(key)}, ${JSON.stringify(value)})`;
  const getItem = (key: string) => `() => localStorage.getItem(${JSON.stringify(key)})`;

  it('storage-state: save then restore into a new session', async () => {
    const h = state.harness;
    const src = await h.launch({ slug: 'src' });
    await h.callJson('navigate', { session_id: src, url: state.fixture.url('/') });
    await h.callJson('evaluate', {
      session_id: src,
      expression: setItem('session', 'restored-value'),
    });
    const saved = await h.callJson<{ name: string; size: number }>('save_storage_state', {
      session_id: src,
      name: 'my-login',
    });
    expect(saved.name).toBe('my-login');
    expect(saved.size).toBeGreaterThan(0);
    expect(await h.callJson<unknown>('list_saved_auths')).toEqual([
      expect.objectContaining({ name: 'my-login', kind: 'storage' }),
    ]);
    const dst = await h.launch({
      slug: 'dst',
      persistence_mode: 'storage-state',
      context_options: { storageState: 'my-login' },
    });
    await h.callJson('navigate', { session_id: dst, url: state.fixture.url('/') });
    expect(
      (
        await h.callJson<{ result: string }>('evaluate', {
          session_id: dst,
          expression: getItem('session'),
        })
      ).result,
    ).toBe('restored-value');
  });

  it('storage-state: IndexedDB survives save and restore', async () => {
    const h = state.harness;
    const putIdb = `() => new Promise((resolve, reject) => {
      const open = indexedDB.open('bh-auth', 1);
      open.onupgradeneeded = () => open.result.createObjectStore('kv');
      open.onerror = () => reject(open.error);
      open.onsuccess = () => {
        const tx = open.result.transaction('kv', 'readwrite');
        tx.objectStore('kv').put('idb-token', 'auth');
        tx.oncomplete = () => resolve('ok');
        tx.onerror = () => reject(tx.error);
      };
    })`;
    const getIdb = `() => new Promise((resolve, reject) => {
      const open = indexedDB.open('bh-auth', 1);
      open.onupgradeneeded = () => open.result.createObjectStore('kv');
      open.onerror = () => reject(open.error);
      open.onsuccess = () => {
        const get = open.result.transaction('kv').objectStore('kv').get('auth');
        get.onsuccess = () => resolve(get.result ?? null);
        get.onerror = () => reject(get.error);
      };
    })`;
    const src = await h.launch({ slug: 'idb-src' });
    await h.callJson('navigate', { session_id: src, url: state.fixture.url('/') });
    await h.callJson('evaluate', { session_id: src, expression: putIdb });
    await h.callJson('save_storage_state', { session_id: src, name: 'idb-login' });
    const dst = await h.launch({
      slug: 'idb-dst',
      persistence_mode: 'storage-state',
      context_options: { storageState: 'idb-login' },
    });
    await h.callJson('navigate', { session_id: dst, url: state.fixture.url('/') });
    const read = await h.callJson<{ result: unknown }>('evaluate', {
      session_id: dst,
      expression: getIdb,
    });
    expect(read.result).toBe('idb-token');
  });

  it('full-profile: save through the tool, and restore a flushed profile into a new persistent session', async () => {
    const h = state.harness;
    const src = await h.launch({ slug: 'psrc', persistence_mode: 'persistent' });
    await h.callJson('navigate', { session_id: src, url: state.fixture.url('/') });
    await h.callJson('evaluate', { session_id: src, expression: setItem('profile', 'deep-state') });
    const liveResult = await h.call('save_full_profile', { session_id: src, name: 'live-profile' });
    const liveSaved = liveResult.isError !== true;
    if (liveSaved) {
      expect((JSON.parse(textOf(liveResult)) as { size: number }).size).toBeGreaterThan(0);
    } else {
      // Windows only: the running browser holds its cookie database exclusively, so a live save is
      // refused with a typed, actionable error instead of an incomplete archive.
      expect(process.platform).toBe('win32');
      expect(textOf(liveResult)).toContain('PROFILE_FILE_LOCKED');
      expect(textOf(liveResult)).toContain('is locked by the running browser');
      expect(textOf(liveResult)).not.toContain('INTERNAL_ERROR');
    }
    // A consistent snapshot comes from a flushed profile: closing commits Chromium's DOM storage to
    // disk, then the store zips the quiescent managed dir.
    expect(
      (await h.callJson<{ closed: boolean }>('close_session', { session_id: src })).closed,
    ).toBe(true);
    const saved = await h.services.authStates.saveFullProfile(
      join(h.dataDir, 'sessions', src, 'userdata'),
      'work-profile',
      src,
      LOCAL_PRINCIPAL,
    );
    expect(saved.size).toBeGreaterThan(0);
    const dst = await h.launch({
      slug: 'pdst',
      persistence_mode: 'persistent',
      restore_profile: 'work-profile',
    });
    await h.callJson('navigate', { session_id: dst, url: state.fixture.url('/') });
    const restored = await h.callJson<{ result: string | null }>('evaluate', {
      session_id: dst,
      expression: getItem('profile'),
    });
    expect(restored.result).toBe('deep-state');
    const listed = await h.callJson<{ name: string; kind: string }[]>('list_saved_auths');
    expect(listed.map((e) => e.name).sort()).toEqual(
      liveSaved ? ['live-profile', 'work-profile'] : ['work-profile'],
    );
  });

  it('full-profile: a logged-in cookie survives save_full_profile and restore_profile, caches stay out', async () => {
    const h = state.harness;
    // Chromium writes cookies to disk in batches or on close, so the login is first made durable:
    // set a persistent cookie, close, and seed a profile with it.
    const seed = await h.launch({ slug: 'ck-seed', persistence_mode: 'persistent' });
    await h.callJson('navigate', {
      session_id: seed,
      url: state.fixture.url('/set-cookie?name=sid&v=logged-in&max_age=86400'),
    });
    await h.callJson('navigate', { session_id: seed, url: state.fixture.url('/') });
    await h.callJson('close_session', { session_id: seed });
    await h.services.authStates.saveFullProfile(
      join(h.dataDir, 'sessions', seed, 'userdata'),
      'ck-seed',
      seed,
      LOCAL_PRINCIPAL,
    );
    // A live, browsed session holding that login is what the agent snapshots through the tool.
    const live = await h.launch({
      slug: 'ck-live',
      persistence_mode: 'persistent',
      restore_profile: 'ck-seed',
    });
    await h.callJson('navigate', { session_id: live, url: state.fixture.url('/') });
    const userdata = join(h.dataDir, 'sessions', live, 'userdata');
    const result = await h.call('save_full_profile', { session_id: live, name: 'logged-in' });
    let path: string;
    if (result.isError === true) {
      // Windows only: the running browser holds its cookie database exclusively (see above).
      expect(process.platform).toBe('win32');
      expect(textOf(result)).toContain('PROFILE_FILE_LOCKED');
      await h.callJson('close_session', { session_id: live });
      ({ path } = await h.services.authStates.saveFullProfile(
        userdata,
        'logged-in',
        live,
        LOCAL_PRINCIPAL,
      ));
    } else {
      ({ path } = JSON.parse(textOf(result)) as { path: string });
      await h.callJson('close_session', { session_id: live });
    }
    // The browsed profile has an HTTP cache; the snapshot does not, and keeps the cookie database.
    expect(await readdir(join(userdata, 'Default'))).toContain('Cache');
    const names = Object.keys(unzipSync(new Uint8Array(await readFile(path))));
    expect(names.some((n) => /^Default\/(Network\/)?Cookies$/.test(n))).toBe(true);
    for (const cache of PROFILE_CACHE_DIRS) {
      expect(names.filter((n) => n.includes(`${cache}/`))).toEqual([]);
    }
    const dst = await h.launch({
      slug: 'ck-dst',
      persistence_mode: 'persistent',
      restore_profile: 'logged-in',
    });
    await h.callJson('navigate', { session_id: dst, url: state.fixture.url('/echo-headers') });
    const got = await h.callJson<{ cookies: { name: string; value: string }[] }>('get_cookies', {
      session_id: dst,
      urls: [state.fixture.origin],
    });
    expect(got.cookies.find((c) => c.name === 'sid')?.value).toBe('logged-in');
    expect(state.fixture.requests.at(-1)?.headers['cookie']).toContain('sid=logged-in');
  });

  it('restoring a missing name fails with AUTH_STATE_NOT_FOUND', async () => {
    const h = state.harness;
    const result = await h.call('launch_session', {
      slug: 'miss',
      persistence_mode: 'storage-state',
      context_options: { storageState: 'does-not-exist' },
    });
    expect(textOf(result)).toBe(
      "[AUTH_STATE_NOT_FOUND] No saved storage-state snapshot named 'does-not-exist'. Use list_saved_auths to see what is available.",
    );
  });
});
