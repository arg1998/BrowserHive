/** @module infra/site-packs/verify-layout.test — a whole signed layout (spec 13 §10.1): valid with its own root, refused by this build's pinned root (a test-key preview never verifies in a release), an absent, swapped or oversized pack file, a revoked version, the stored floors and `index_floor`. */

import { describe, expect, it } from 'bun:test';
import { buildLayout, canonical, readerOf, sigOf } from '../../../test/helpers/registry-kit.ts';
import { sitePack } from '../../../test/helpers/site-pack-kit.ts';
import { PINNED_TRUST_ROOT } from './trust-root.ts';
import { verifySignedLayout } from './verify-layout.ts';

const NOW = Date.parse('2026-11-22T12:00:00Z');
const PACKS = [sitePack('site-a.test', 2), sitePack('site-b.test', 7)];

describe('verifySignedLayout', () => {
  it('accepts a complete layout with its root', async () => {
    const layout = buildLayout({ now: NOW, packs: PACKS });
    const report = await verifySignedLayout({
      read: readerOf(layout.files),
      root: layout.trustRoot,
      now: NOW,
      binaryVersion: '0.3.0',
    });
    expect(report.ok).toBe(true);
    expect(report.refusal).toBeNull();
    expect(report.packs.map((p) => [p.id, p.version, p.status])).toEqual([
      ['site-a.test', 2, 'ok'],
      ['site-b.test', 7, 'ok'],
    ]);
    expect(report.keys?.signedBy).toBe(layout.root.keyId);
    expect(report.index?.signedBy).toBe(layout.online.keyId);
  });

  it("this release's pinned root refuses a layout signed by a test root", async () => {
    const layout = buildLayout({ now: NOW, packs: PACKS });
    const report = await verifySignedLayout({
      read: readerOf(layout.files),
      root: PINNED_TRUST_ROOT,
      now: NOW,
      binaryVersion: null,
    });
    expect(report.ok).toBe(false);
    expect(report.refusal?.file).toBe('keys.json');
    expect(['no_trust_root', 'unknown_key']).toContain(report.refusal?.reason ?? '');
  });

  it('an absent, swapped or oversized pack file fails the layout; the chain still verified', async () => {
    const layout = buildLayout({ now: NOW, packs: PACKS });
    const [a, b] = [...layout.files.keys()].filter((p) => p.startsWith('packs/'));
    layout.files.delete(a ?? '');
    layout.files.set(b ?? '', new TextEncoder().encode('{}'));
    const report = await verifySignedLayout({
      read: readerOf(layout.files),
      root: layout.trustRoot,
      now: NOW,
      binaryVersion: null,
    });
    expect(report.ok).toBe(false);
    expect(report.refusal).toBeNull();
    expect(report.packs.map((p) => p.status)).toEqual(['absent', 'refused']);
    layout.files.set(b ?? '', new Uint8Array(64 * 1024 + 2));
    const big = await verifySignedLayout({
      read: readerOf(layout.files),
      root: layout.trustRoot,
      now: NOW,
      binaryVersion: null,
    });
    expect(big.packs[1]?.detail).toBe('too_large');
  });

  it('a missing signature file refuses the chain', async () => {
    const layout = buildLayout({ now: NOW, packs: PACKS });
    layout.files.delete('index.json.sig');
    const report = await verifySignedLayout({
      read: readerOf(layout.files),
      root: layout.trustRoot,
      now: NOW,
      binaryVersion: null,
    });
    expect(report.refusal).toMatchObject({ file: 'index.json.sig', reason: 'missing' });
    expect(report.keys).not.toBeNull();
  });

  it('marks revoked versions and versions for another BrowserHive', async () => {
    const layout = buildLayout({
      now: NOW,
      packs: [sitePack('site-a.test', 2, { min_client: '9.0.0' })],
    });
    const doc = layout.indexDoc as { packs: { versions: Record<string, unknown>[] }[] };
    const entry = doc.packs[0]?.versions[0];
    if (entry !== undefined) entry['revoked'] = true;
    const index = canonical(doc);
    layout.files.set('index.json', index);
    layout.files.set('index.json.sig', sigOf(index, layout.online));
    const report = await verifySignedLayout({
      read: readerOf(layout.files),
      root: layout.trustRoot,
      now: NOW,
      binaryVersion: '0.3.0',
    });
    expect(report.ok).toBe(true);
    expect(report.packs[0]).toMatchObject({ status: 'other_client', revoked: true });
  });

  it('applies the stored floors; index_floor in keys.json resets the index floor', async () => {
    const layout = buildLayout({ now: NOW, index: { version: 10 } });
    const read = readerOf(layout.files);
    const rolled = await verifySignedLayout({
      read,
      root: layout.trustRoot,
      now: NOW,
      binaryVersion: null,
      floors: { keysVersion: null, indexVersion: 20 },
    });
    expect(rolled.refusal?.reason).toBe('rollback');
    const reset = buildLayout({ now: NOW, index: { version: 10 }, keys: { index_floor: 5 } });
    const accepted = await verifySignedLayout({
      read: readerOf(reset.files),
      root: reset.trustRoot,
      now: NOW,
      binaryVersion: null,
      floors: { keysVersion: 1, indexVersion: 900_000 },
    });
    expect(accepted.ok).toBe(true);
    const keysRolled = await verifySignedLayout({
      read,
      root: layout.trustRoot,
      now: NOW,
      binaryVersion: null,
      floors: { keysVersion: 2, indexVersion: null },
    });
    expect(keysRolled.refusal).toMatchObject({ file: 'keys.json', reason: 'rollback' });
  });
});
