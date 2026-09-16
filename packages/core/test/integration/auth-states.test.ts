/** @module test/integration/auth-states — save_storage_state / save_full_profile + restore through launch_session against real Chromium. */

import { describe, expect, it } from 'bun:test';
import { join } from 'node:path';
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

  it('full-profile: save through the tool, and restore a flushed profile into a new persistent session', async () => {
    const h = state.harness;
    const src = await h.launch({ slug: 'psrc', persistence_mode: 'persistent' });
    await h.callJson('navigate', { session_id: src, url: state.fixture.url('/') });
    await h.callJson('evaluate', { session_id: src, expression: setItem('profile', 'deep-state') });
    const live = await h.callJson<{ name: string; size: number }>('save_full_profile', {
      session_id: src,
      name: 'live-profile',
    });
    expect(live.size).toBeGreaterThan(0);
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
    expect(listed.map((e) => e.name).sort()).toEqual(['live-profile', 'work-profile']);
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
