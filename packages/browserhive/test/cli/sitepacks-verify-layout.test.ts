/** @module test/cli/sitepacks-verify-layout — `browserhive sitepacks verify <dir>` for a signed registry layout (spec 13 §10.1, §11.5, T4a acceptance): accepted with the test root a suite injects, refused by the root pinned in this release (a pull-request preview's test key never verifies in a release), a tampered pack file or a missing signature fails, `--json`, hostile text kept printable. */
import { describe, expect, it } from 'bun:test';
import { buildLayout, canonical, sigOf } from '@browserhive/core/test/registry-kit';
import { z } from 'zod';
import { cliHarness } from './helpers.ts';

const NOW = Date.parse('2026-11-22T12:00:00Z');
const DIR = '/work/registry/v1';

function pack(id: string, version: number) {
  return {
    schema: 1 as const,
    id,
    version,
    min_client: '0.1.0',
    title: `Site ${id}`,
    domains: [id],
    sign_in: { url: { host: `www.${id}`, path: '/login' }, human_only: false },
    signed_in: {
      probe: { host: `www.${id}`, path: '/account' },
      kind: 'redirect' as const,
      signed_out_redirects: [`www.${id}/login*`],
    },
    write_policy: { default: 'confirm' as const, stance: 'prohibited' as const },
  };
}

function filesOf(layout: ReturnType<typeof buildLayout>): Record<string, string> {
  const decoder = new TextDecoder();
  return Object.fromEntries(
    [...layout.files].map(([path, bytes]) => [`${DIR}/${path}`, decoder.decode(bytes)]),
  );
}

const Report = z.object({
  kind: z.literal('layout'),
  ok: z.boolean(),
  keys: z.object({ version: z.number(), signed_by: z.string() }).nullable(),
  index: z.object({ version: z.number(), signed_by: z.string(), expires: z.string() }).nullable(),
  refusal: z.object({ file: z.string(), reason: z.string(), detail: z.string() }).nullable(),
  packs: z.array(z.object({ id: z.string(), version: z.number(), status: z.string() })),
});

async function verify(
  layout: ReturnType<typeof buildLayout>,
  options: { json?: boolean; pinned?: boolean; files?: Record<string, string> } = {},
) {
  return cliHarness({
    argv: ['sitepacks', 'verify', DIR, ...(options.json === true ? ['--json'] : [])],
    files: options.files ?? filesOf(layout),
    overrides: {
      clock: { now: () => NOW },
      ...(options.pinned !== true && { sitePacksTrustRoot: layout.trustRoot }),
    },
  });
}

describe('sitepacks verify <signed layout>', () => {
  const layout = buildLayout({ now: NOW, packs: [pack('site-a.test', 2), pack('site-b.test', 5)] });

  it('accepts a layout signed under the test root the suite injects (exit 0)', async () => {
    const run = await verify(layout);
    expect(run.code).toBe(0);
    expect(run.stdout).toContain('valid: keys.json v1');
    expect(run.stdout).toContain('2 of 2 pack files verified');
    expect(run.storage.opened).toEqual([]);
  });

  it('--json reports the chain and every pack file', async () => {
    const report = Report.parse(JSON.parse((await verify(layout, { json: true })).stdout));
    expect(report.ok).toBe(true);
    expect(report.keys?.signed_by).toBe(layout.root.keyId);
    expect(report.index?.signed_by).toBe(layout.online.keyId);
    expect(report.packs.map((p) => [p.id, p.status])).toEqual([
      ['site-a.test', 'ok'],
      ['site-b.test', 'ok'],
    ]);
  });

  it("this release's own root keys refuse the test-key layout (exit 1)", async () => {
    const run = await verify(layout, { pinned: true, json: true });
    expect(run.code).toBe(1);
    const report = Report.parse(JSON.parse(run.stdout));
    expect(report.refusal?.file).toBe('keys.json');
    expect(['no_trust_root', 'unknown_key']).toContain(report.refusal?.reason ?? '');
  });

  it('a pack file changed after signing fails; so does a missing signature', async () => {
    const files = filesOf(layout);
    const packPath = Object.keys(files).find((p) => p.includes('/packs/site-b.test/')) ?? '';
    files[packPath] = (files[packPath] ?? '').replace('Site site-b.test', 'Site site-b.evil');
    const tampered = await verify(layout, { files });
    expect(tampered.code).toBe(1);
    expect(tampered.stdout).toContain('site-b.test v5: refused (hash_mismatch');
    const unsigned = filesOf(layout);
    delete unsigned[`${DIR}/index.json.sig`];
    const missing = await verify(layout, { files: unsigned });
    expect(missing.code).toBe(1);
    expect(missing.stdout).toContain('index.json.sig: missing');
  });

  it('a hostile index cannot drive the terminal', async () => {
    const evil = buildLayout({ now: NOW, packs: [pack('site-a.test', 2)] });
    const doc = evil.indexDoc as { packs: { versions: Record<string, unknown>[] }[] };
    const entry = doc.packs[0]?.versions[0];
    if (entry !== undefined) entry['path'] = 'packs/\u001b[2Kx.json';
    const index = canonical(doc);
    evil.files.set('index.json', index);
    evil.files.set('index.json.sig', sigOf(index, evil.online));
    const run = await verify(evil);
    expect(run.code).toBe(1);
    expect(run.stdout).not.toContain('\u001b');
  });

  it('one content-addressed pack file of the layout verifies: id from its folder, SHA-256 from its name (review #100 L7)', async () => {
    const path = [...layout.files.keys()].find((p) => p.startsWith('packs/site-a.test/')) ?? '';
    const ok = await cliHarness({
      argv: ['sitepacks', 'verify', `${DIR}/${path}`],
      files: filesOf(layout),
    });
    expect(ok.code).toBe(0);
    expect(ok.stdout).toContain('site-a.test v2');
    // The same content under another content address is refused: the name is its hash.
    const wrong = `${DIR}/packs/site-a.test/${'0'.repeat(64)}.json`;
    const files = { ...filesOf(layout), [wrong]: filesOf(layout)[`${DIR}/${path}`] ?? '' };
    const bad = await cliHarness({ argv: ['sitepacks', 'verify', wrong, '--json'], files });
    expect(bad.code).toBe(1);
    expect(JSON.parse(bad.stdout)).toMatchObject({ ok: false, reason: 'hash_mismatch' });
    // The folder name is the id: the file under another pack's folder is refused.
    const moved = `${DIR}/packs/site-b.test/${path.split('/')[2] ?? ''}`;
    const misplaced = await cliHarness({
      argv: ['sitepacks', 'verify', moved, '--json'],
      files: { ...filesOf(layout), [moved]: filesOf(layout)[`${DIR}/${path}`] ?? '' },
    });
    expect(JSON.parse(misplaced.stdout)).toMatchObject({ ok: false, reason: 'id_mismatch' });
  });
});
