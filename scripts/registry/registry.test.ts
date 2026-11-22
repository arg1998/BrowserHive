/** @module scripts/registry/registry.test — the publishing scripts on a throwaway repository with a single commit (spec 13 §10.7; a squash merge leaves no history, review #97 H1): keys made at run time with `registry-keys.mjs`, `registry-build.ts --out` (also outside git), `node registry-sign.mjs sign` without dependencies, verified by core's verifier with those roots and refused by this build's pinned root; the published layout's checks before a signature (review M1: unverifiable, foreign signer, rollback, fast-forward, non-numeric; M3: a published version changed; never a silent version 1); tampering between build and sign; previews; `carry` only of this commit's layout (M4); `--check` against a base; `registry-keys.mjs` imports only Node built-ins (M5).
 *
 * Timeouts: every case starts Node or Bun child processes (Bun loads core for `registry-build.ts`)
 * and derives scrypt keys (N = 2^17, about 0.3 s each); Windows runners start processes several
 * times slower than Linux (job 137117856369 hit Bun's 5 s default), so each case gets 60 s.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  createHash,
  createPrivateKey,
  generateKeyPairSync,
  type KeyObject,
  sign,
} from 'node:crypto';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { SitePacksTrustRoot } from '@browserhive/core/ports/site-packs';
import { PINNED_TRUST_ROOT, verifySignedLayout } from '@browserhive/core/server';
import { canonicalJson, readRootKeys } from '../registry-common.mjs';
import { addOnlineKey, initRoots, readRootKeyFile, resignKeys } from '../registry-keys.mjs';
import { syncRegistry } from './sync.ts';

const T = 60_000;
const REPO = resolve(import.meta.dir, '..', '..');
const PASS = `pass-${Math.random().toString(36).slice(2)}-phrase`;
const NODE = process.env['BHDEV_NODE'] ?? 'node';
const TRUST_ROOT = join('packages', 'core', 'src', 'infra', 'site-packs', 'trust-root.ts');

/** The key id a foreign signer claims (built at run time; a literal would read as a secret to gitleaks). */
const FOREIGN_ID = 'f'.repeat(16);

/** An index edit that changes nothing (the layout is only re-signed). */
const unchanged = (_index: Record<string, unknown>): void => undefined;

let work: string;
let repo: string;
let secret: string;
let root: SitePacksTrustRoot;

const git = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { stdio: 'pipe' });

function run(command: string, args: string[], env: Record<string, string> = {}) {
  const result = spawnSync(command, args, {
    cwd: REPO,
    env: { ...process.env, CI: '', GITHUB_STEP_SUMMARY: '', REGISTRY_ONLINE_KEY: '', ...env },
    encoding: 'utf8',
  });
  return { code: result.status ?? -1, out: `${result.stdout}${result.stderr}` };
}

const build = (at: string, ...args: string[]) =>
  run(process.execPath, [join(REPO, 'scripts', 'registry-build.ts'), '--repo', at, ...args]);
const signer = (args: string[], env: Record<string, string> = {}) =>
  run(NODE, [join(REPO, 'scripts', 'registry-sign.mjs'), ...args, '--repo', repo], env);
const signed = (out: string, previous: string, extra: string[] = []) =>
  signer(
    ['sign', '--artefact', join(work, 'art'), '--out', out, '--previous', previous, ...extra],
    {
      REGISTRY_ONLINE_KEY: secret,
    },
  );

function pack(version: number, title: string): string {
  const real = JSON.parse(readFileSync(join(REPO, 'registry', 'packs', 'github.com.json'), 'utf8'));
  return canonicalJson({ ...real, version, title, min_client: '0.1.0' });
}

function writeNotes(): void {
  const path = join(repo, 'registry', 'versions', 'github.com.json');
  const meta = JSON.parse(readFileSync(path, 'utf8'));
  for (const entry of Object.values(meta.versions) as Record<string, string>[]) {
    if (entry['notes'] === '') entry['notes'] = 'A test version.';
  }
  writeFileSync(path, canonicalJson(meta));
}

function setPack(version: number, title: string): void {
  writeFileSync(join(repo, 'registry', 'packs', 'github.com.json'), pack(version, title));
  syncRegistry(repo, '2026-11-20');
  writeNotes();
}

function setState(version: number): void {
  writeFileSync(
    join(repo, 'registry', 'state.json'),
    canonicalJson({ schema: 1, index_version: version }),
  );
}

async function verify(dir: string, trust: SitePacksTrustRoot) {
  return verifySignedLayout({
    read: async (path) => {
      try {
        return new Uint8Array(readFileSync(join(dir, path)));
      } catch {
        return null;
      }
    },
    root: trust,
    now: Date.now(),
    binaryVersion: null,
  });
}

/** A copy of the published layout `from`, its index changed by `edit` and signed by `key` (default: the online key). */
function doctored(
  name: string,
  from: string,
  edit: (index: Record<string, unknown>) => void,
  key?: KeyObject,
  keyId?: string,
): string {
  const dir = join(work, name);
  cpSync(from, dir, { recursive: true });
  const index = JSON.parse(readFileSync(join(dir, 'index.json'), 'utf8'));
  edit(index);
  const bytes = Buffer.from(canonicalJson(index));
  const [, id, b64] = secret.split('.');
  const privateKey =
    key ??
    createPrivateKey({ key: Buffer.from(b64 ?? '', 'base64'), format: 'der', type: 'pkcs8' });
  writeFileSync(join(dir, 'index.json'), bytes);
  writeFileSync(
    join(dir, 'index.json.sig'),
    canonicalJson({
      schema: 1,
      signatures: [{ key_id: keyId ?? id, sig: sign(null, bytes, privateKey).toString('base64') }],
    }),
  );
  return dir;
}

beforeAll(() => {
  work = mkdtempSync(join(tmpdir(), 'bh-registry-'));
  repo = join(work, 'repo');
  mkdirSync(join(repo, 'registry', 'packs'), { recursive: true });
  cpSync(join(REPO, 'registry', 'keys'), join(repo, 'registry', 'keys'), { recursive: true });
  mkdirSync(join(repo, TRUST_ROOT, '..'), { recursive: true });
  cpSync(join(REPO, TRUST_ROOT), join(repo, TRUST_ROOT));
  setState(0);
  setPack(1, 'GitHub one');
  setPack(2, 'GitHub');
  const offline = join(work, 'offline');
  mkdirSync(offline, { mode: 0o700 });
  const paths = {
    pubDir: join(repo, 'registry', 'keys'),
    trustRoot: join(repo, TRUST_ROOT),
    test: false,
  };
  initRoots(paths, offline, [PASS, PASS], Date.now(), false);
  const root1 = readRootKeyFile(join(offline, 'root-1.key'), PASS);
  addOnlineKey(paths, root1, join(offline, 'online.secret'), 30, { now: Date.now(), keysDays: 60 });
  secret = readFileSync(join(offline, 'online.secret'), 'utf8').trim();
  const roots = readRootKeys(paths.pubDir);
  root = { keys: roots.keys.map((k) => ({ keyId: k.key_id, publicKey: k.public_key })) };
  // One commit, no history: what a squash merge leaves (review #97 H1).
  execFileSync('git', ['init', '-q', repo]);
  git('config', 'user.email', 'test@example.invalid');
  git('config', 'user.name', 'Test');
  git('config', 'commit.gpgsign', 'false');
  git('config', 'core.autocrlf', 'false');
  git('add', '-A');
  git('commit', '-q', '-m', 'squashed');
}, T);

afterAll(() => rmSync(work, { recursive: true, force: true }));

describe('registry-build → registry-sign', () => {
  it(
    'builds both versions from the archive alone, with or without git',
    () => {
      const art = join(work, 'art');
      expect(build(repo, '--out', art).code).toBe(0);
      const index = JSON.parse(readFileSync(join(art, 'index.json'), 'utf8'));
      expect(Object.keys(index)).toEqual(['packs', 'schema']);
      expect(index.packs[0].versions.map((v: { v: number }) => v.v)).toEqual([2, 1]);
      const plain = join(work, 'no-git');
      cpSync(repo, plain, { recursive: true, filter: (p) => !p.startsWith(join(repo, '.git')) });
      const again = join(work, 'art-no-git');
      expect(build(plain, '--out', again).code).toBe(0);
      expect(readFileSync(join(again, 'index.json'), 'utf8')).toBe(
        readFileSync(join(art, 'index.json'), 'utf8'),
      );
    },
    T,
  );

  it(
    'never signs a first version 1 by accident; --first-publish does, verified by core',
    async () => {
      const empty = join(work, 'nothing-published');
      mkdirSync(empty);
      const refused = signed(join(work, 'no-first'), empty);
      expect(refused.code).toBe(1);
      expect(refused.out).toContain('first_publish');
      const first = join(work, 'signed');
      const result = signed(first, empty, [
        '--first-publish',
        '--checksums',
        join(work, 'sums.txt'),
      ]);
      expect(result.out).toContain('version 1');
      const report = await verify(first, root);
      expect(report.ok).toBe(true);
      expect(report.packs.map((p) => [p.version, p.status])).toEqual([
        [2, 'ok'],
        [1, 'ok'],
      ]);
      expect((await verify(first, PINNED_TRUST_ROOT)).ok).toBe(false);
      expect(readFileSync(join(work, 'sums.txt'), 'utf8')).toContain('  index.json.sig');
    },
    T,
  );

  it(
    'the next signature takes the next version, never below registry/state.json',
    async () => {
      expect(signed(join(work, 'signed-2'), join(work, 'signed')).code).toBe(0);
      expect((await verify(join(work, 'signed-2'), root)).index?.value.version).toBe(2);
      setState(40);
      const below = signed(join(work, 'signed-3'), join(work, 'signed-2'));
      expect(below.out).toContain('below the 40 registry/state.json records');
      setState(2);
      expect(signed(join(work, 'signed-3'), join(work, 'signed-2')).code).toBe(0);
      expect((await verify(join(work, 'signed-3'), root)).index?.value.version).toBe(3);
      setState(0);
    },
    T,
  );

  it(
    'refuses a published layout it cannot trust: foreign signer, fast-forward, no number, changed version',
    () => {
      const live = join(work, 'signed');
      const { privateKey } = generateKeyPairSync('ed25519');
      const cases: [string, string, string][] = [
        [
          'foreign',
          doctored('foreign', live, unchanged, privateKey, FOREIGN_ID),
          'signed by no online key',
        ],
        [
          'fast-forward',
          doctored('ff', live, (i) => {
            i['version'] = 9e15;
          }),
          'a fast-forward',
        ],
        [
          'nan',
          doctored('nan', live, (i) => {
            i['version'] = 'not-a-number';
          }),
          'no valid version',
        ],
        [
          'changed',
          doctored('changed', live, (i) => {
            const packs = i['packs'] as { versions: { sha256: string }[] }[];
            const v = packs[0]?.versions[0];
            if (v !== undefined) v.sha256 = '0'.repeat(64);
          }),
          'published with other content',
        ],
      ];
      for (const [name, dir, message] of cases) {
        const result = signed(join(work, `out-${name}`), dir);
        expect([name, result.code]).toEqual([name, 1]);
        expect(result.out).toContain(message);
      }
    },
    T,
  );

  it(
    'refuses an artefact tampered with between build and sign, and a missing or foreign key',
    () => {
      const cases: [string, (dir: string) => void][] = [
        [
          'pack',
          (dir) => {
            const index = JSON.parse(readFileSync(join(dir, 'index.json'), 'utf8'));
            const path = join(dir, index.packs[0].versions[0].path);
            writeFileSync(path, readFileSync(path, 'utf8').replace('"GitHub"', '"GitHub!"'));
          },
        ],
        [
          'index',
          (dir) => {
            const path = join(dir, 'index.json');
            writeFileSync(path, readFileSync(path, 'utf8').replace('A test version.', 'Edited.'));
          },
        ],
        [
          'extra',
          (dir) => writeFileSync(join(dir, 'packs', 'github.com', `${'0'.repeat(64)}.json`), '{}'),
        ],
        ['keys', (dir) => writeFileSync(join(dir, 'keys.json'), '{}\n')],
      ];
      for (const [what, tamper] of cases) {
        const dir = join(work, `tampered-${what}`);
        cpSync(join(work, 'art'), dir, { recursive: true });
        tamper(dir);
        const args = ['sign', '--artefact', dir, '--out', `${dir}-out`];
        const result = signer([...args, '--previous', join(work, 'signed')], {
          REGISTRY_ONLINE_KEY: secret,
        });
        expect([what, result.code]).toEqual([what, 1]);
        expect(result.out).toContain('refused');
      }
      const base = ['sign', '--artefact', join(work, 'art'), '--previous', join(work, 'signed')];
      expect(signer([...base, '--out', join(work, 'no-secret')]).out).toContain(
        'REGISTRY_ONLINE_KEY is not set',
      );
      const other = secret.replace(/^bhreg1\.[0-9a-f]{16}\./, 'bhreg1.0000000000000000.');
      expect(
        signer([...base, '--out', join(work, 'other')], { REGISTRY_ONLINE_KEY: other }).code,
      ).toBe(1);
    },
    T,
  );

  it(
    'a preview signs with a throwaway test root that only it trusts',
    async () => {
      const preview = join(work, 'preview');
      const args = ['sign', '--artefact', join(work, 'art'), '--out', preview];
      expect(signer([...args, '--test-keys', join(work, 'preview-keys')]).code).toBe(0);
      const pub = JSON.parse(readFileSync(join(work, 'preview-keys', 'test-root.pub'), 'utf8'));
      expect(pub.test).toBe(true);
      const testRoot = { keys: [{ keyId: pub.key_id, publicKey: pub.public_key }] };
      expect((await verify(preview, testRoot)).ok).toBe(true);
      expect((await verify(preview, root)).ok).toBe(false);
      expect((await verify(preview, PINNED_TRUST_ROOT)).ok).toBe(false);
    },
    T,
  );

  it(
    "carry re-publishes only this commit's verified layout",
    () => {
      const live = join(work, 'signed-3');
      expect(signer(['carry', '--from', live, '--out', join(work, 'carried')]).code).toBe(0);
      expect(readFileSync(join(work, 'carried', 'index.json'))).toEqual(
        readFileSync(join(live, 'index.json')),
      );
      const broken = join(work, 'broken');
      cpSync(live, broken, { recursive: true });
      const index = JSON.parse(readFileSync(join(broken, 'index.json'), 'utf8'));
      writeFileSync(join(broken, index.packs[0].versions[0].path), '{}');
      expect(signer(['carry', '--from', broken, '--out', join(work, 'broken-out')]).code).toBe(1);
      const { privateKey } = generateKeyPairSync('ed25519');
      const foreign = doctored('carry-foreign', live, unchanged, privateKey, FOREIGN_ID);
      expect(signer(['carry', '--from', foreign, '--out', join(work, 'foreign-out')]).code).toBe(1);
      // A newer keys.json in the commit (a rotation or revocation): the old layout is not carried.
      const paths = { pubDir: join(repo, 'registry', 'keys'), trustRoot: null, test: false };
      const root2 = readRootKeyFile(join(work, 'offline', 'root-2.key'), PASS);
      resignKeys(paths, root2, { now: Date.now(), keysDays: 60 });
      const stale = signer(['carry', '--from', live, '--out', join(work, 'stale-out')]);
      expect(stale.out).toContain("not this commit's registry/keys/keys.json");
      git('checkout', '-q', '--', 'registry/keys');
    },
    T,
  );
});

describe('registry-build --check against a base', () => {
  const head = () => git('rev-parse', 'HEAD').toString().trim();
  const reset = () => {
    git('checkout', '-q', '--', '.');
    git('clean', '-qfd');
  };

  it(
    'classifies a pack change and enforces the version rules',
    () => {
      const file = join(repo, 'registry', 'packs', 'github.com.json');
      const current = JSON.parse(readFileSync(file, 'utf8'));
      writeFileSync(file, canonicalJson({ ...current, guards: current.guards.slice(1) }));
      const same = build(repo, '--check', '--base', head());
      expect(same.code).toBe(1);
      expect(same.out).toContain('its version must be above v2');
      writeFileSync(
        file,
        canonicalJson({ ...current, version: 3, guards: current.guards.slice(1) }),
      );
      syncRegistry(repo, '2026-11-21');
      writeNotes();
      const bumped = build(repo, '--check', '--base', head());
      expect(bumped.code).toBe(0);
      expect(bumped.out).toContain('github.com: v2 → v3 — **loosening**');
      expect(bumped.out).toContain('| `guards[logout]` |');
      reset();
    },
    T,
  );

  it(
    'refuses a published version changed or removed',
    () => {
      const versionsPath = join(repo, 'registry', 'versions', 'github.com.json');
      const meta = JSON.parse(readFileSync(versionsPath, 'utf8'));
      const archive = join(repo, 'registry', 'archive', 'github.com');
      const oldSha: string = meta.versions['1'].sha256;
      const v1 = pack(1, 'GitHub one, edited');
      const sha = createHash('sha256').update(v1).digest('hex');
      writeFileSync(join(archive, `${sha}.json`), v1);
      rmSync(join(archive, `${oldSha}.json`));
      const edited = { ...meta.versions['1'], sha256: sha };
      writeFileSync(
        versionsPath,
        canonicalJson({ ...meta, versions: { ...meta.versions, 1: edited } }),
      );
      const changed = build(repo, '--check', '--base', head());
      expect(changed.code).toBe(1);
      expect(changed.out).toContain("github.com v1: a published version's content changed");
      reset();
      rmSync(join(archive, `${oldSha}.json`));
      const { 1: _dropped, ...rest } = meta.versions;
      writeFileSync(versionsPath, canonicalJson({ ...meta, versions: rest }));
      expect(build(repo, '--check', '--base', head()).out).toContain(
        'github.com v1: a published version cannot be removed',
      );
      reset();
    },
    T,
  );
});

describe('registry-keys.mjs', () => {
  it('imports nothing but Node built-ins (no repository file, no package)', () => {
    const source = readFileSync(join(REPO, 'scripts', 'registry-keys.mjs'), 'utf8');
    const specifiers = [
      ...source.matchAll(/^\s*(?:import|export)\s[^'"]*?from\s+['"]([^'"]+)['"]/gm),
    ].map((m) => m[1] ?? '');
    expect(specifiers.length).toBeGreaterThan(0);
    expect(specifiers.filter((s) => !s.startsWith('node:'))).toEqual([]);
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    expect(code).not.toMatch(/\bimport\s*\(/);
    expect(code).not.toMatch(/\brequire\s*\(/);
  });

  it(
    'works from the command line with plain node; dry-run is verified by core in another process',
    () => {
      const passFile = join(work, 'pass.txt');
      writeFileSync(passFile, `${PASS}\n`);
      const tool = join(REPO, 'scripts', 'registry-keys.mjs');
      const keys = (...args: string[]) =>
        run(NODE, [tool, ...args, '--repo', repo, '--passphrase-file', passFile]);
      const keysJson = join(repo, 'registry', 'keys', 'keys.json');
      const before = JSON.parse(readFileSync(keysJson, 'utf8')).version;
      const secretOut = join(work, 'offline', 'next.secret');
      const added = keys(
        'online-key',
        '--root',
        join(work, 'offline', 'root-2.key'),
        '--secret-out',
        secretOut,
      );
      expect(added.out).toContain('gh secret set REGISTRY_ONLINE_KEY --env registry-signing');
      expect(JSON.parse(readFileSync(keysJson, 'utf8')).version).toBe(before + 1);
      // The secret file is never overwritten; keys.json lives at most 120 days.
      expect(
        keys('online-key', '--root', join(work, 'offline', 'root-1.key'), '--secret-out', secretOut)
          .code,
      ).toBe(1);
      expect(
        keys('sign-keys', '--root', join(work, 'offline', 'root-1.key'), '--keys-days', '121').out,
      ).toContain('at most 120 days');
      expect(keys('status').out).toContain('keys.json verifies under the root keys');
      expect(keys('init-roots', '--out', join(repo, 'keys-here')).out).toContain(
        'inside a git working tree',
      );
      git('checkout', '-q', '--', 'registry/keys');
      const dry = run(NODE, [
        tool,
        'dry-run',
        '--out',
        join(work, 'dry'),
        '--layout',
        join(work, 'art'),
      ]);
      expect(dry.code).toBe(0);
      expect(dry.out).toContain('throwaway root: accepted');
      expect(dry.out).toContain('pinned root: pins none of them');
      const checked = run(process.execPath, [
        join(REPO, 'scripts', 'registry-verify.ts'),
        join(work, 'dry', 'layout'),
        '--test-root',
        join(work, 'dry', 'registry-keys', 'root-1.pub'),
        '--test-root',
        join(work, 'dry', 'registry-keys', 'root-2.pub'),
        '--expect-pinned-refusal',
      ]);
      expect(checked.out).toContain('2 of 2 pack files verified');
      expect(checked.code).toBe(0);
    },
    T,
  );
});
