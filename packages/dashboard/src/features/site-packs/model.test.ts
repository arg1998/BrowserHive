/** @module features/site-packs/model.test — the pure site-pack helpers: provenance lines for every source, the pack that owns a host, what adding a site approves and its sentence, the nav badge count, diff values as text, the decisions waiting (followed and unpinned updates, local files without a problem), the import issues parser and the live cache patch */
import { describe, expect, it } from 'bun:test';
import { QueryClient } from '@tanstack/react-query';
import { keys } from '@/lib/api/keys.ts';
import { offeredPack, packsResponse, packView, sha } from '../../../test/fixtures/site-packs.ts';
import { importIssues } from './ImportPack.tsx';
import { applySitePackEvent } from './live.ts';
import {
  approvalSentence,
  iso,
  packChoice,
  packForHost,
  packsNeedingReview,
  provenanceText,
  valueText,
} from './model.ts';
import { pendingDecisions } from './UpdatesSection.tsx';

const PENDING = {
  version: 4,
  sha256: sha('c'),
  state: 'downloaded' as const,
  size: null,
  released: null,
  notes: null,
  source: 'bundled' as const,
  provenance: null,
};

describe('site-pack model', () => {
  it('words every provenance', () => {
    expect(provenanceText({ kind: 'bundled', release: '0.3.0' }, 'bundled')).toBe(
      'Bundled with BrowserHive 0.3.0',
    );
    expect(provenanceText({ kind: 'local', path: '/x/a.json' }, 'local')).toBe(
      'Local file /x/a.json',
    );
    expect(provenanceText({ kind: 'import', file: 'a.json' }, 'import')).toBe(
      'Imported file a.json',
    );
    expect(
      provenanceText({ kind: 'remote', key_id: 'k-2026a', index_version: 1412 }, 'remote'),
    ).toBe('browserhive.ai registry · key k-2026a · signature verified · index 1412');
    expect(provenanceText(null, 'local')).toBe('Local file');
  });

  it('finds the pack of a host and what adding it approves', () => {
    const packs = [packView(), offeredPack()];
    expect(packForHost(packs, 'www.linkedin.com')?.pack_id).toBe('linkedin.com');
    expect(packForHost(packs, 'licdn.com')?.pack_id).toBe('linkedin.com');
    expect(packForHost(packs, 'notlinkedin.com')).toBeNull();
    const offered = packChoice(offeredPack());
    expect(offered).toMatchObject({ version: 2, sha256: sha('b'), approved: false });
    expect(approvalSentence(offeredPack(), offered ?? (null as never))).toBe(
      `Adding this site approves ${iso('GitHub')} v2 (${iso('Bundled with BrowserHive 0.3.0')}, SHA-256 ${sha('b').slice(0, 12)}…).`,
    );
    expect(packChoice(packView())).toMatchObject({ version: 3, approved: true });
    expect(packChoice(offeredPack({ offer: null }))).toBeNull();
  });

  it('counts the badge and lists the decisions waiting', () => {
    expect(
      packsNeedingReview(packsResponse([], { pending_count: 2, local_needing_approval: 1 })),
    ).toBe(3);
    expect(packsNeedingReview(undefined)).toBe(0);
    const local = {
      path: '/l/a.json',
      sha256: sha('d'),
      state: 'changed' as const,
      approved_sha256: sha('a'),
      problem: null,
    };
    const decisions = pendingDecisions([
      packView({ pending: [PENDING], local }),
      packView({ pack_id: 'pinned.com', pending: [PENDING], pinned_version: 3 }),
      packView({
        pack_id: 'off.com',
        pending: [PENDING],
        follow: { setting: 'off', effective: false },
      }),
      packView({ pack_id: 'bad.com', local: { ...local, problem: 'invalid JSON' } }),
    ]).map((d) => d.key);
    expect(decisions).toEqual(['linkedin.com@local', 'linkedin.com@4']);
  });

  it('shows diff values as text', () => {
    expect(valueText(undefined)).toBe('(none)');
    expect(valueText('block')).toBe('block');
    expect(valueText(['GET', 'POST'])).toBe('["GET","POST"]');
    expect(valueText({ a: '<b>' })).toBe('{"a":"<b>"}');
  });

  it('parses import issues without casting', () => {
    expect(
      importIssues({ issues: [{ path: 'id', message: 'bad' }, { path: 1 }, 'x', null] }),
    ).toEqual([{ path: 'id', message: 'bad' }]);
    expect(importIssues({})).toEqual([]);
  });

  it('patches a changed pack into the cached lists', () => {
    const qc = new QueryClient();
    qc.setQueryData(keys.sitePacks.catalog(), packsResponse([packView(), offeredPack()]));
    applySitePackEvent(qc, { type: 'site_pack.changed', view: packView({ enabled: false }) });
    const data = qc.getQueryData<{ data: { pack_id: string; enabled: boolean }[] }>(
      keys.sitePacks.catalog(),
    );
    expect(data?.data.map((p) => [p.pack_id, p.enabled])).toEqual([
      ['linkedin.com', false],
      ['github.com', true],
    ]);
  });
});
