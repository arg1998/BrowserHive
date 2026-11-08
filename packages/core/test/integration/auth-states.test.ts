/** @module test/integration/auth-states — save_storage_state / save_full_profile + restore through launch_session against real Chromium, including two token principals sharing a name (spec 13 T0a). */

import { describe, expect, it } from 'bun:test';
import { join } from 'node:path';
import { agentPrincipal, LOCAL_PRINCIPAL } from '../../src/domain/auth/principal.ts';
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

  it("two token principals: bob saving alice's name never restores alice's cookies", async () => {
    const h = state.harness;
    const aliceP = agentPrincipal('alice', {});
    const alice = await h.connect(aliceP);
    const bob = await h.connect(agentPrincipal('bob', {}));
    const origin = state.fixture.origin;
    const expires = Math.floor(Date.now() / 1000) + 3600;
    const cookiesOf = async (sessionId: string, via: typeof alice) => {
      await h.callJson('navigate', { session_id: sessionId, url: state.fixture.url('/') }, via);
      const got = await h.callJson<{ cookies: { name: string; value: string }[] }>(
        'get_cookies',
        { session_id: sessionId, urls: [origin] },
        via,
      );
      return got.cookies.filter((c) => c.name === 'sid').map((c) => c.value);
    };

    // Alice: a full profile carrying her cookie, saved from the flushed profile (as above).
    const aliceSrc = await h.launch({ slug: 'alice-src', persistence_mode: 'persistent' }, alice);
    await h.callJson('navigate', { session_id: aliceSrc, url: state.fixture.url('/') }, alice);
    await h.callJson(
      'set_cookies',
      {
        session_id: aliceSrc,
        cookies: [{ name: 'sid', value: 'ALICE-COOKIE', url: origin, expires }],
      },
      alice,
    );
    await h.callJson('close_session', { session_id: aliceSrc }, alice);
    await h.services.authStates.saveFullProfile(
      join(h.dataDir, 'sessions', aliceSrc, 'userdata'),
      'work',
      aliceSrc,
      aliceP,
    );

    // Bob saves a storage state under the same name.
    const bobSrc = await h.launch({ slug: 'bob-src' }, bob);
    await h.callJson('navigate', { session_id: bobSrc, url: state.fixture.url('/') }, bob);
    await h.callJson(
      'set_cookies',
      { session_id: bobSrc, cookies: [{ name: 'sid', value: 'BOB-COOKIE', url: origin }] },
      bob,
    );
    await h.callJson('save_storage_state', { session_id: bobSrc, name: 'work' }, bob);

    // Bob's profile restore of that name finds nothing: he has no full profile called `work`.
    const stolen = await h.call(
      'launch_session',
      { slug: 'bob-steal', persistence_mode: 'persistent', restore_profile: 'work' },
      bob,
    );
    expect(textOf(stolen)).toBe(
      "[AUTH_STATE_NOT_FOUND] No saved full-profile snapshot named 'work'. Use list_saved_auths to see what is available.",
    );
    // His storage-state restore gets his own cookie only.
    const bobDst = await h.launch(
      {
        slug: 'bob-dst',
        persistence_mode: 'storage-state',
        context_options: { storageState: 'work' },
      },
      bob,
    );
    expect(await cookiesOf(bobDst, bob)).toEqual(['BOB-COOKIE']);
    // Alice still restores her own profile, cookie included.
    const aliceDst = await h.launch(
      { slug: 'alice-dst', persistence_mode: 'persistent', restore_profile: 'work' },
      alice,
    );
    expect(await cookiesOf(aliceDst, alice)).toEqual(['ALICE-COOKIE']);
    // Each lists only its own snapshot; the shared `local` caller sees neither.
    const kinds = async (via?: typeof alice) =>
      (await h.callJson<{ name: string; kind: string }[]>('list_saved_auths', {}, via)).map((e) => [
        e.name,
        e.kind,
      ]);
    expect(await kinds(alice)).toEqual([['work', 'profile']]);
    expect(await kinds(bob)).toEqual([['work', 'storage']]);
    expect(await kinds()).toEqual([]);
  });
});
