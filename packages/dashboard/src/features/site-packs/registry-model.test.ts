/** @module features/site-packs/registry-model.test — the registry client's words (spec 13 §10.4–§10.6, §11.4): the check line per state, why Check now and downloads are unavailable, client ranges, the newest version beyond the one in force, other sources, the toasts of Check now and Download all, an import's counts; and a signed folder picked in the browser as the import body (`import-layout`) */
import { describe, expect, it } from 'bun:test';
import {
  onlineStatus,
  packView,
  pendingVersion,
  registryStatus,
  sha,
} from '../../../test/fixtures/site-packs.ts';
import { layoutBody, type PickedFile } from './import-layout.ts';
import {
  CHECK_OFF_TEXT,
  checkLine,
  checkNowBlocked,
  checkToast,
  clientRangeText,
  downloadAllToast,
  downloadBlocked,
  importCounts,
  importLayoutTitle,
  needsClientText,
  newestAvailable,
  otherSources,
} from './registry-model.ts';

describe('the check line', () => {
  it('says what the last check found, per state', () => {
    expect(checkLine(onlineStatus(), 0)).toMatchObject({ outcome: 'up to date', tone: 'success' });
    expect(checkLine(onlineStatus(), 2)?.outcome).toBe('2 updates');
    expect(checkLine(onlineStatus(), 1)?.outcome).toBe('1 update');
    expect(checkLine(onlineStatus({ last_outcome: 'failed', failures: 3 }), 0)).toMatchObject({
      outcome: 'failed',
      tone: 'danger',
    });
    expect(checkLine(onlineStatus({ stale: true }), 0)?.outcome).toBe('index out of date');
    expect(checkLine(onlineStatus({ last_check_at: null }), 0)?.outcome).toBe('Not checked yet');
    expect(checkLine(registryStatus(), 0)).toMatchObject({ at: null, outcome: 'Update check off' });
    expect(checkLine(registryStatus({ check_off: 'no_trust_root' }), 0)?.outcome).toBe(
      'No registry trusted yet',
    );
    expect(checkLine(registryStatus({ enabled: false }), 0)).toBeNull();
  });

  it('Check now and downloads say why they are unavailable', () => {
    expect(checkNowBlocked(onlineStatus())).toBeNull();
    expect(checkNowBlocked(registryStatus())).toBe(CHECK_OFF_TEXT.update_check_off);
    expect(checkNowBlocked(registryStatus({ check_off: 'no_trust_root' }))).toContain(
      'trusts no registry yet',
    );
    expect(downloadBlocked(onlineStatus())).toBeNull();
    expect(downloadBlocked(undefined)).toBeNull();
    expect(downloadBlocked(onlineStatus({ stale: true }))).toContain('out of date');
    expect(downloadBlocked(onlineStatus({ index_version: null }))).toContain('Check now');
    expect(downloadBlocked(registryStatus())).toContain('makes no request');
  });
});

describe('what the index lists for a pack', () => {
  it('reads client ranges as words', () => {
    expect(clientRangeText('0.4.0')).toBe('≥ 0.4.0');
    expect(clientRangeText('>=0.4.0')).toBe('≥ 0.4.0');
    expect(clientRangeText('>=0.4.0 <=0.5.0')).toBe('≥ 0.4.0 ≤ 0.5.0');
  });

  it('finds the newest version beyond the one in force and one for another BrowserHive', () => {
    const online = {
      version: 7,
      sha256: sha('f'),
      size: 1,
      released: '2026-11-20',
      notes: '',
      revoked: false,
      needs_client: '>=0.4.0',
      usable_version: 5,
    };
    expect(newestAvailable(packView({ online }))).toBe(5);
    expect(newestAvailable(packView({ online, pending: [pendingVersion({ version: 6 })] }))).toBe(
      6,
    );
    expect(newestAvailable(packView())).toBeNull();
    expect(needsClientText(packView({ online }))).toBe('v7 needs BrowserHive ≥ 0.4.0');
    expect(needsClientText(packView())).toBeNull();
  });

  it('names the other sources that know the pack', () => {
    expect(otherSources(packView({ sources: ['bundled', 'remote'] }), 'bundled')).toBe(
      'Also online',
    );
    expect(otherSources(packView({ sources: ['bundled'] }), 'bundled')).toBe('');
    expect(otherSources(packView({ sources: ['import', 'remote', 'bundled'] }), 'import')).toBe(
      'Also bundled · online',
    );
  });
});

describe('toasts', () => {
  it('Check now: each outcome', () => {
    const status = onlineStatus({ index_version: 1413 });
    expect(checkToast({ outcome: 'updated', checked_at: 1, available: 2, status })).toMatchObject({
      kind: 'success',
      title: 'Index 1413 verified',
      description: 'Signature checked: 2 newer versions listed.',
    });
    expect(checkToast({ outcome: 'not_modified', checked_at: 1, available: 0, status }).title).toBe(
      'Up to date',
    );
    expect(
      checkToast({
        outcome: 'failed',
        checked_at: 1,
        available: 0,
        status,
        error: { code: 'fetch_failed', message: 'browserhive.ai did not answer.' },
      }),
    ).toMatchObject({ kind: 'error', description: expect.stringContaining('did not answer') });
    expect(
      checkToast({ outcome: 'disabled', checked_at: 1, available: 0, status: registryStatus() })
        .kind,
    ).toBe('info');
  });

  it('Download all: what was fetched, held and refused', () => {
    const t = downloadAllToast({
      downloaded: [{ pack_id: 'linkedin.com', version: 4, sha256: sha('c') }],
      held: 2,
      refused: [{ pack_id: 'x.com', version: 3, reason: 'sha_mismatch', detail: 'wrong SHA-256' }],
      pending_count: 1,
    });
    expect(t.kind).toBe('warning');
    expect(t.title).toBe('Downloaded 1 version');
    expect(t.description).toContain('2 already held');
    expect(t.description).toContain('x.com v3: wrong SHA-256');
    expect(t.description).toContain('1 waiting for your review');
  });

  it('an import: the index and the versions by state', () => {
    const response = {
      imported: [
        { pack_id: 'a.com', version: 2, state: 'downloaded' as const, sha256: sha('a') },
        { pack_id: 'b.com', version: 3, state: 'refused' as const, sha256: sha('b') },
      ],
      layout: {
        outcome: 'updated' as const,
        index_version: 1413,
        keys_version: 3,
        signed_by: 'k-2026a',
      },
    };
    expect(importCounts(response)).toBe('1 waits for review · 1 refused.');
    expect(importLayoutTitle(response, 'export-nov')).toBe(
      'Signed folder export-nov verified: index 1413',
    );
    expect(importLayoutTitle(response, 'selected files')).toBe(
      'The signed files verified: index 1413',
    );
  });
});

/** A picked file from text. */
function picked(relativePath: string, text: string, name = relativePath.split('/').at(-1) ?? '') {
  const bytes = new TextEncoder().encode(text);
  return { name, relativePath, size: bytes.length, bytes: async () => bytes } satisfies PickedFile;
}

describe('a signed folder as the import body', () => {
  it('keeps paths under the folder that holds keys.json, leaves hidden files out', async () => {
    const body = await layoutBody([
      picked('export/v1/keys.json', '{}'),
      picked('export/v1/keys.json.sig', 'sig'),
      picked('export/v1/index.json', '{"v":1}'),
      picked('export/v1/index.json.sig', 'sig'),
      picked(`export/v1/packs/a.com/${sha('a')}.json`, '{"id":"a.com"}'),
      picked('export/v1/.DS_Store', 'junk'),
      picked('export/README.txt', 'outside'),
    ]);
    expect(body.ok).toBe(true);
    if (!body.ok) return;
    expect(body.name).toBe('v1');
    expect(Object.keys(body.files).sort()).toEqual([
      'index.json',
      'index.json.sig',
      'keys.json',
      'keys.json.sig',
      `packs/a.com/${sha('a')}.json`,
    ]);
    expect(atob(body.files['index.json'] ?? '')).toBe('{"v":1}');
  });

  it('places a pack file picked without its folder under packs/<id>/', async () => {
    const body = await layoutBody([
      picked('', '{}', 'keys.json'),
      picked('', '{"id":"b.com","version":2}', `${sha('b')}.json`),
    ]);
    expect(body.ok && Object.keys(body.files)).toEqual([
      'keys.json',
      `packs/b.com/${sha('b')}.json`,
    ]);
    expect(body.ok && body.name).toBe('selected files');
  });

  it('refuses a folder without keys.json or larger than 1 MiB', async () => {
    const none = await layoutBody([picked('x/index.json', '{}')]);
    expect(none.ok).toBe(false);
    expect(!none.ok && none.problem).toContain('keys.json');
    const big = await layoutBody([
      picked('x/keys.json', '{}'),
      picked('x/index.json', 'a'.repeat(900_000)),
    ]);
    expect(!big.ok && big.problem).toContain('larger than 1 MiB');
  });
});
