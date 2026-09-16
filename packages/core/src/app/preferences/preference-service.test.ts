/** @module app/preferences/preference-service.test — validation (known keys, per-key schema, 64 KiB cap), replace/set/list semantics. */

import { describe, expect, it } from 'bun:test';
import { CollectingLogger } from '../../../test/helpers/collecting-logger.ts';
import { FakeClock } from '../../../test/helpers/fake-clock.ts';
import { isAppError } from '../../kernel/errors/app-error.ts';
import type { PreferenceRepository } from '../../ports/persistence/notifications.ts';
import type { PreferenceRecord } from '../../ports/persistence/records.ts';
import { PreferenceService, parsePreferences } from './preference-service.ts';

class MemoryPreferences implements PreferenceRepository {
  readonly rows = new Map<string, PreferenceRecord>();
  async list(principalId: string) {
    return [...this.rows.values()].filter((r) => r.principalId === principalId);
  }
  async get(principalId: string, key: string) {
    return this.rows.get(`${principalId}|${key}`) ?? null;
  }
  async set(principalId: string, key: string, value: unknown, at: number) {
    this.rows.set(`${principalId}|${key}`, { principalId, key, value, updatedAt: at });
  }
  async replaceAll(principalId: string, values: Readonly<Record<string, unknown>>, at: number) {
    for (const r of await this.list(principalId)) this.rows.delete(`${principalId}|${r.key}`);
    for (const [key, value] of Object.entries(values)) await this.set(principalId, key, value, at);
  }
  async remove(principalId: string, key: string) {
    return this.rows.delete(`${principalId}|${key}`);
  }
}

function setup() {
  const repo = new MemoryPreferences();
  const clock = new FakeClock();
  return {
    repo,
    clock,
    service: new PreferenceService({ repo, clock, logger: new CollectingLogger() }),
  };
}

function validationPaths(fn: () => unknown): string[] {
  try {
    fn();
  } catch (err) {
    if (isAppError(err) && err.code === 'VALIDATION_FAILED') {
      const details = err.details as { issues: { path: string }[] };
      return details.issues.map((i) => i.path);
    }
    throw err;
  }
  throw new Error('expected VALIDATION_FAILED');
}

describe('parsePreferences', () => {
  it('accepts known keys and rejects unknown keys and bad values', () => {
    expect(parsePreferences({ sidebar: 'collapsed', default_page_size: 50 })).toEqual({
      sidebar: 'collapsed',
      default_page_size: 50,
    });
    expect(validationPaths(() => parsePreferences({ theme: 'dark' }))).toEqual(['']);
    expect(validationPaths(() => parsePreferences({ default_page_size: 5 }))).toEqual([
      'default_page_size',
    ]);
  });

  it('rejects documents over 64 KiB', () => {
    const views = Array.from({ length: 100 }, (_, i) => ({
      id: `v${i}`,
      name: 'view',
      route: '/sessions',
      search: { q: 'x'.repeat(1000) },
    }));
    expect(validationPaths(() => parsePreferences({ saved_views: views }))).toEqual([
      'preferences',
    ]);
  });
});

describe('PreferenceService', () => {
  it('replaceAll removes absent keys; list returns the newest updated_at', async () => {
    const { service, clock } = setup();
    await service.replaceAll('p1', { sidebar: 'expanded', default_page_size: 25 });
    await clock.advance(10);
    const stored = await service.replaceAll('p1', { sidebar: 'collapsed' });
    const doc = await service.list('p1');
    expect(doc.preferences).toEqual({ sidebar: 'collapsed' });
    expect(doc.updatedAt).toBe(stored.updatedAt);
    expect(await service.list('p2')).toEqual({ preferences: {}, updatedAt: null });
  });

  it('set validates one key', async () => {
    const { service } = setup();
    await service.set('p1', 'notifications', { toasts: false });
    expect((await service.list('p1')).preferences).toEqual({ notifications: { toasts: false } });
    await expect(service.set('p1', 'sidebar', 'wide')).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
    });
  });

  it('list drops stored rows that no longer validate', async () => {
    const { service, repo } = setup();
    await repo.set('p1', 'sidebar', 'collapsed', 1);
    await repo.set('p1', 'default_page_size', 'nope', 2);
    expect((await service.list('p1')).preferences).toEqual({ sidebar: 'collapsed' });
  });
});
