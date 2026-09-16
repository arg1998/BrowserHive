/** @module test/integration/persistence — persistent (managed userdata) and storage-state modes against real Chromium. */

import { describe, expect, it } from 'bun:test';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { useMcpStack } from './mcp-fixture.ts';

describe('persistence modes (real Chromium)', () => {
  const { state } = useMcpStack();

  it('persistent mode creates and populates the managed userdata dir', async () => {
    const h = state.harness;
    const id = await h.launch({ slug: 'persist', persistence_mode: 'persistent' });
    const meta = await h.callJson<{ persistence_mode: string }[]>('list_sessions');
    expect(meta[0]?.persistence_mode).toBe('persistent');
    await h.callJson('navigate', { session_id: id, url: state.fixture.url('/') });
    await h.callJson('evaluate', {
      session_id: id,
      expression: "() => localStorage.setItem('token', 'abc123')",
    });
    expect(
      (
        await h.callJson<{ result: string }>('evaluate', {
          session_id: id,
          expression: "() => localStorage.getItem('token')",
        })
      ).result,
    ).toBe('abc123');
    expect((await readdir(join(h.dataDir, 'sessions', id, 'userdata'))).length).toBeGreaterThan(0);
  });

  it('storage-state mode restores a seeded localStorage entry', async () => {
    const h = state.harness;
    const id = await h.launch({
      slug: 'restore',
      persistence_mode: 'storage-state',
      context_options: {
        storageState: {
          cookies: [],
          origins: [
            { origin: state.fixture.origin, localStorage: [{ name: 'seeded', value: 'yes' }] },
          ],
        },
      },
    });
    await h.callJson('navigate', { session_id: id, url: state.fixture.url('/') });
    expect(
      (
        await h.callJson<{ result: string }>('evaluate', {
          session_id: id,
          expression: "() => localStorage.getItem('seeded')",
        })
      ).result,
    ).toBe('yes');
  });

  it('memory and persistent sessions do not share a profile', async () => {
    const h = state.harness;
    const persistent = await h.launch({ slug: 'p1', persistence_mode: 'persistent' });
    const memory = await h.launch({ slug: 'm1' });
    await h.callJson('navigate', { session_id: persistent, url: state.fixture.url('/') });
    await h.callJson('evaluate', {
      session_id: persistent,
      expression: "() => localStorage.setItem('only', 'persistent')",
    });
    await h.callJson('navigate', { session_id: memory, url: state.fixture.url('/') });
    expect(
      (
        await h.callJson<{ result: string | null }>('evaluate', {
          session_id: memory,
          expression: "() => localStorage.getItem('only')",
        })
      ).result,
    ).toBeNull();
  });
});
