/** @module app/templates/state-reconcile.test — the boot pass over template files (spec 13 §2.4): orphan version files deleted, files on another key reported as `TEMPLATE_KEY_MISMATCH`, files without a key as `TEMPLATE_KEY_MISSING`. */

import { describe, expect, it } from 'bun:test';
import { CollectingLogger } from '../../../test/helpers/collecting-logger.ts';
import { FakeTemplateStateStore } from '../../../test/helpers/fake-state-store.ts';
import { InMemoryRepositories } from '../../../test/helpers/in-memory-repos.ts';
import { RecordingDegradations } from '../../../test/helpers/template-kit.ts';
import { templateKeyOf } from '../../domain/templates/envelope.ts';
import { reconcileTemplateState } from './state-reconcile.ts';

const STATE = { cookies: [], origins: [] };
const OTHER = templateKeyOf(new Uint8Array(32).fill(8));

async function versionRow(repos: InMemoryRepositories, templateId: string, version: number) {
  await repos.templateVersions.insert({
    templateId,
    version,
    reason: 'manual',
    restoredFrom: null,
    sizeBytes: 1,
    sha256: 'x',
    keyId: 'k',
    structureSha256: 's',
    summary: { domains: [], storageOrigins: 0 },
    health: [],
    pinned: false,
    createdBy: 'a',
    createdAt: 1,
  });
}

describe('template state at boot (spec 13 §2.4)', () => {
  it('deletes version files without a row and keeps the checkpoint', async () => {
    const store = new FakeTemplateStateStore();
    const repos = new InMemoryRepositories();
    await store.write('tp-aaaaaaaaaa', 'latest', STATE);
    await store.write('tp-aaaaaaaaaa', 1, STATE);
    await store.write('tp-aaaaaaaaaa', 2, STATE);
    await versionRow(repos, 'tp-aaaaaaaaaa', 1);
    const degradations = new RecordingDegradations();
    const result = await reconcileTemplateState({
      store,
      repos,
      degradations,
      logger: new CollectingLogger(),
    });
    expect(result.orphansRemoved).toBe(1);
    expect((await store.files('tp-aaaaaaaaaa')).map((f) => f.slot).sort()).toEqual([1, 'latest']);
    expect(degradations.reports).toEqual([]);
  });

  it('reports files on another key, and files without any key', async () => {
    const store = new FakeTemplateStateStore();
    const repos = new InMemoryRepositories();
    await store.write('tp-aaaaaaaaaa', 'latest', STATE);
    store.keys = { current: OTHER, previous: null };
    const degradations = new RecordingDegradations();
    const deps = { store, repos, degradations, logger: new CollectingLogger() };
    const mismatch = await reconcileTemplateState(deps);
    expect([...mismatch.mismatched]).toEqual([['tp-aaaaaaaaaa', ['latest']]]);
    expect(degradations.reports.map((r) => r.code)).toEqual(['TEMPLATE_KEY_MISMATCH']);
    store.keys = { current: null, previous: null };
    const missing = await reconcileTemplateState(deps);
    expect(missing.keyMissing).toBe(true);
    expect(degradations.reports.map((r) => r.code)).toContain('TEMPLATE_KEY_MISSING');
    expect(degradations.reports.at(-1)?.details).toEqual({ template_ids: ['tp-aaaaaaaaaa'] });
  });
});
