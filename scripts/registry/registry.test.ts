/** @module scripts/registry/registry.test — the publishing scripts' round trip on a throwaway git repository (spec 13 §10.7, T4a acceptance): root and online keys made at run time with keys-ops, `registry-build.ts --out` then `node registry-sign.mjs sign` without dependencies, the result verified by core's verifier with those roots and refused by this build's pinned root; tampering with the artefact between build and sign is refused; the next signature takes the next version; previews sign with a throwaway test root; `carry` re-publishes verified files only; `--check` against a base enforces the version rules and prints each change's classification. */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { SitePacksTrustRoot } from '@browserhive/core/ports/site-packs';
import { PINNED_TRUST_ROOT, verifySignedLayout } from '@browserhive/core/server';
import { canonicalJson, readRootKeys } from '../registry-common.mjs';
import { readRootKeyFile } from './keyfile.ts';
import { addOnlineKey, initRoots, type KeyPaths } from './keys-ops.ts';

const REPO = resolve(import.meta.dir, '..', '..');
const PASS = `pass-${Math.random().toString(36).slice(2)}-phrase`;
const NODE = process.env['BHDEV_NODE'] ?? 'node';

let work: string;
let repo: string;
let secret: string;
let root: SitePacksTrustRoot;

function git(...args: string[]): void {
  execFileSync('git', ['-C', repo, ...args], { stdio: 'ignore' });
}

function run(command: string, args: string[], env: Record<string, string> = {}) {
  const result = spawnSync(command, args, {
    cwd: REPO,
    env: { ...process.env, CI: '', GITHUB_STEP_SUMMARY: '', ...env },
    encoding: 'utf8',
  });
  return { code: result.status ?? -1, out: `${result.stdout}${result.stderr}` };
}

const build = (...args: string[]) =>
  run(process.execPath, [join(REPO, 'scripts', 'registry-build.ts'), '--repo', repo, ...args]);
const signer = (args: string[], env: Record<string, string> = {}) =>
  run(NODE, [join(REPO, 'scripts', 'registry-sign.mjs'), ...args, '--repo', repo], env);

function pack(version: number, title: string): string {
  const real = JSON.parse(readFileSync(join(REPO, 'registry', 'packs', 'github.com.json'), 'utf8'));
  return canonicalJson({ ...real, version, title, min_client: '0.1.0' });
}

function versions(...vs: number[]): string {
  return canonicalJson({
    schema: 1,
    versions: Object.fromEntries(
      vs.map((v) => [String(v), { released: '2026-11-20', notes: `Version ${v}.` }]),
    ),
  });
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

beforeAll(() => {
  work = mkdtempSync(join(tmpdir(), 'bh-registry-'));
  repo = join(work, 'repo');
  const trustRoot = join(repo, 'packages', 'core', 'src', 'infra', 'site-packs', 'trust-root.ts');
  mkdirSync(join(repo, 'registry', 'packs'), { recursive: true });
  mkdirSync(join(repo, 'registry', 'versions'), { recursive: true });
  cpSync(join(REPO, 'registry', 'keys'), join(repo, 'registry', 'keys'), { recursive: true });
  mkdirSync(join(trustRoot, '..'), { recursive: true });
  cpSync(join(REPO, 'packages', 'core', 'src', 'infra', 'site-packs', 'trust-root.ts'), trustRoot);
  execFileSync('git', ['init', '-q', repo]);
  git('config', 'user.email', 'test@example.invalid');
  git('config', 'user.name', 'Test');
  git('config', 'commit.gpgsign', 'false');
  // Bytes are signed and hashed exactly: no line-ending conversion on checkout (Windows runners).
  git('config', 'core.autocrlf', 'false');
  writeFileSync(join(repo, 'registry', 'packs', 'github.com.json'), pack(1, 'GitHub one'));
  writeFileSync(join(repo, 'registry', 'versions', 'github.com.json'), versions(1));
  git('add', '-A');
  git('commit', '-q', '-m', 'v1');
  writeFileSync(join(repo, 'registry', 'packs', 'github.com.json'), pack(2, 'GitHub'));
  writeFileSync(join(repo, 'registry', 'versions', 'github.com.json'), versions(1, 2));
  // Keys made now, for this run only: two roots (encrypted at rest) and an online key.
  const offline = join(work, 'offline');
  mkdirSync(offline, { mode: 0o700 });
  const paths: KeyPaths = { pubDir: join(repo, 'registry', 'keys'), trustRoot, test: false };
  initRoots(paths, offline, [PASS, PASS], Date.now(), false);
  const root1 = readRootKeyFile(join(offline, 'root-1.key'), PASS);
  addOnlineKey(paths, root1, join(offline, 'online.secret'), 30, { now: Date.now(), keysDays: 60 });
  secret = readFileSync(join(offline, 'online.secret'), 'utf8').trim();
  git('add', '-A');
  git('commit', '-q', '-m', 'v2 and keys');
  const roots = readRootKeys(paths.pubDir);
  root = { keys: roots.keys.map((k) => ({ keyId: k.key_id, publicKey: k.public_key })) };
});

afterAll(() => rmSync(work, { recursive: true, force: true }));

describe('registry-build → registry-sign', () => {
  it('builds the content-addressed layout with both versions and keys.json', () => {
    const art = join(work, 'art');
    const built = build('--out', art);
    expect(built.code).toBe(0);
    const index = JSON.parse(readFileSync(join(art, 'index.json'), 'utf8'));
    expect(Object.keys(index)).toEqual(['packs', 'schema']);
    expect(index.packs[0].versions.map((v: { v: number }) => v.v)).toEqual([2, 1]);
    for (const v of index.packs[0].versions) {
      expect(v.path).toBe(`packs/github.com/${v.sha256}.json`);
      expect(readFileSync(join(art, v.path)).byteLength).toBe(v.size);
    }
    expect(readFileSync(join(art, 'keys.json'), 'utf8')).toBe(
      readFileSync(join(repo, 'registry', 'keys', 'keys.json'), 'utf8'),
    );
  });

  it('signs the artefact: core accepts it with the new roots, this build refuses it', async () => {
    const empty = join(work, 'nothing-published');
    mkdirSync(empty);
    const signed = join(work, 'signed');
    const result = signer(
      [
        'sign',
        '--artefact',
        join(work, 'art'),
        '--out',
        signed,
        '--previous',
        empty,
        '--checksums',
        join(work, 'sums.txt'),
      ],
      { REGISTRY_ONLINE_KEY: secret },
    );
    expect(result.out).toContain('version 1');
    expect(result.code).toBe(0);
    const report = await verify(signed, root);
    expect(report.ok).toBe(true);
    expect(report.packs.map((p) => [p.version, p.status])).toEqual([
      [2, 'ok'],
      [1, 'ok'],
    ]);
    expect((await verify(signed, PINNED_TRUST_ROOT)).ok).toBe(false);
    expect(readFileSync(join(work, 'sums.txt'), 'utf8')).toContain('  index.json.sig');
  });

  it('the next signature over the published layout takes the next version', async () => {
    const again = join(work, 'signed-2');
    const result = signer(
      ['sign', '--artefact', join(work, 'art'), '--out', again, '--previous', join(work, 'signed')],
      {
        REGISTRY_ONLINE_KEY: secret,
      },
    );
    expect(result.code).toBe(0);
    expect((await verify(again, root)).index?.value.version).toBe(2);
  });

  it('refuses an artefact tampered with between build and sign', () => {
    const cases: [string, (dir: string) => void][] = [
      [
        'a pack file changed',
        (dir) => {
          const index = JSON.parse(readFileSync(join(dir, 'index.json'), 'utf8'));
          const path = join(dir, index.packs[0].versions[0].path);
          writeFileSync(path, readFileSync(path, 'utf8').replace('"GitHub"', '"GitHub!"'));
        },
      ],
      [
        'the unsigned index changed',
        (dir) => {
          const path = join(dir, 'index.json');
          writeFileSync(path, readFileSync(path, 'utf8').replace('Version 2.', 'Version 2!'));
        },
      ],
      [
        'an extra file',
        (dir) => writeFileSync(join(dir, 'packs', 'github.com', `${'0'.repeat(64)}.json`), '{}'),
      ],
      ['keys.json changed', (dir) => writeFileSync(join(dir, 'keys.json'), '{}\n')],
    ];
    for (const [what, tamper] of cases) {
      const dir = join(work, `tampered-${what.replace(/\W/g, '-')}`);
      cpSync(join(work, 'art'), dir, { recursive: true });
      tamper(dir);
      const result = signer(
        ['sign', '--artefact', dir, '--out', `${dir}-out`, '--previous', join(work, 'signed')],
        {
          REGISTRY_ONLINE_KEY: secret,
        },
      );
      expect([what, result.code]).toEqual([what, 1]);
      expect(result.out).toContain('refused');
    }
  });

  it('refuses without the secret, or with a key keys.json does not list', () => {
    const base = ['sign', '--artefact', join(work, 'art'), '--previous', join(work, 'signed')];
    expect(signer([...base, '--out', join(work, 'no-secret')]).out).toContain(
      'REGISTRY_ONLINE_KEY is not set',
    );
    const other = secret.replace(/^bhreg1\.[0-9a-f]{16}\./, 'bhreg1.0000000000000000.');
    expect(
      signer([...base, '--out', join(work, 'other')], { REGISTRY_ONLINE_KEY: other }).code,
    ).toBe(1);
  });

  it('a preview signs with a throwaway test root that only it trusts', async () => {
    const preview = join(work, 'preview');
    const result = signer([
      'sign',
      '--artefact',
      join(work, 'art'),
      '--out',
      preview,
      '--test-keys',
      join(work, 'preview-keys'),
    ]);
    expect(result.code).toBe(0);
    const pub = JSON.parse(readFileSync(join(work, 'preview-keys', 'test-root.pub'), 'utf8'));
    expect(pub.test).toBe(true);
    const testRoot = { keys: [{ keyId: pub.key_id, publicKey: pub.public_key }] };
    expect((await verify(preview, testRoot)).ok).toBe(true);
    expect((await verify(preview, root)).ok).toBe(false);
    expect((await verify(preview, PINNED_TRUST_ROOT)).ok).toBe(false);
  });

  it('carry copies a verified published layout and refuses a doctored one', () => {
    const out = join(work, 'carried');
    expect(signer(['carry', '--from', join(work, 'signed'), '--out', out]).code).toBe(0);
    expect(readFileSync(join(out, 'index.json'))).toEqual(
      readFileSync(join(work, 'signed', 'index.json')),
    );
    const doctored = join(work, 'doctored');
    cpSync(join(work, 'signed'), doctored, { recursive: true });
    const index = JSON.parse(readFileSync(join(doctored, 'index.json'), 'utf8'));
    writeFileSync(join(doctored, index.packs[0].versions[0].path), '{}');
    expect(signer(['carry', '--from', doctored, '--out', join(work, 'doctored-out')]).code).toBe(1);
  });
});

describe('registry-build --check against a base', () => {
  it('reports the classification of a pack change and enforces the version rules', () => {
    git('add', '-A');
    git('commit', '-q', '--allow-empty', '-m', 'base');
    const base = execFileSync('git', ['-C', repo, 'rev-parse', 'HEAD']).toString().trim();
    const file = join(repo, 'registry', 'packs', 'github.com.json');
    const current = JSON.parse(readFileSync(file, 'utf8'));
    // A changed pack without a new version is refused.
    writeFileSync(file, canonicalJson({ ...current, guards: current.guards.slice(1) }));
    const same = build('--check', '--base', base);
    expect(same.code).toBe(1);
    expect(same.out).toContain('its version must be above v2');
    // With a new version and its notes: a classified change.
    writeFileSync(file, canonicalJson({ ...current, version: 3, guards: current.guards.slice(1) }));
    writeFileSync(join(repo, 'registry', 'versions', 'github.com.json'), versions(1, 2, 3));
    const bumped = build('--check', '--base', base);
    expect(bumped.code).toBe(0);
    expect(bumped.out).toContain('github.com: v2 → v3 — **loosening**');
    expect(bumped.out).toContain('| `guards[logout]` |');
    git('checkout', '-q', '--', '.');
  });

  it('refuses a published version whose content changed', () => {
    const base = execFileSync('git', ['-C', repo, 'rev-parse', 'HEAD']).toString().trim();
    const file = join(repo, 'registry', 'packs', 'github.com.json');
    writeFileSync(file, pack(2, 'GitHub, renamed'));
    git('commit', '-q', '-am', 'edit v2 in place');
    writeFileSync(file, pack(3, 'GitHub, renamed'));
    writeFileSync(join(repo, 'registry', 'versions', 'github.com.json'), versions(1, 2, 3));
    const result = build('--check', '--base', base);
    expect(result.code).toBe(1);
    expect(result.out).toContain("github.com v2: a published version's content changed");
    git('reset', '-q', '--hard', base);
  });
  it('refuses to list a version only an intermediate commit of the change held', () => {
    const base = execFileSync('git', ['-C', repo, 'rev-parse', 'HEAD']).toString().trim();
    const file = join(repo, 'registry', 'packs', 'github.com.json');
    writeFileSync(file, pack(3, 'GitHub, never reviewed'));
    git('commit', '-q', '-am', 'v3 in passing');
    writeFileSync(file, pack(4, 'GitHub'));
    writeFileSync(join(repo, 'registry', 'versions', 'github.com.json'), versions(1, 2, 3, 4));
    const result = build('--check', '--base', base);
    expect(result.code).toBe(1);
    expect(result.out).toContain('github.com v3: only the current version (v4)');
    writeFileSync(join(repo, 'registry', 'versions', 'github.com.json'), versions(1, 2, 4));
    expect(build('--check', '--base', base).code).toBe(0);
    git('reset', '-q', '--hard', base);
  });
});

describe('registry-keys.ts', () => {
  it('dry-run rehearses the ceremony and verifies a signed build with core', () => {
    const result = run(process.execPath, [
      join(REPO, 'scripts', 'registry-keys.ts'),
      'dry-run',
      '--out',
      join(work, 'dry'),
      '--layout',
      join(work, 'art'),
    ]);
    expect(result.code).toBe(0);
    expect(result.out).toContain('throwaway root: accepted');
    expect(result.out).toContain('pinned root: refused');
    expect(result.out).toMatch(/throwaway root: valid \(2 of 2 pack files verified\)/);
    expect(result.out).not.toContain('PRIVATE KEY');
  });

  it('online-key, sign-keys, revoke and status work on the repository, offline', () => {
    const passFile = join(work, 'pass-ops.txt');
    writeFileSync(passFile, `${PASS}\n`);
    const keys = (...args: string[]) =>
      run(process.execPath, [
        join(REPO, 'scripts', 'registry-keys.ts'),
        ...args,
        '--repo',
        repo,
        '--passphrase-file',
        passFile,
      ]);
    const version = () =>
      JSON.parse(readFileSync(join(repo, 'registry', 'keys', 'keys.json'), 'utf8')).version;
    const before = version();
    const added = keys(
      'online-key',
      '--root',
      join(work, 'offline', 'root-2.key'),
      '--secret-out',
      join(work, 'offline', 'next.secret'),
    );
    expect(added.code).toBe(0);
    expect(added.out).toContain('gh secret set REGISTRY_ONLINE_KEY --env registry-signing');
    expect(readFileSync(join(work, 'offline', 'next.secret'), 'utf8')).toStartWith('bhreg1.');
    expect(version()).toBe(before + 1);
    const listed = JSON.parse(
      readFileSync(join(repo, 'registry', 'keys', 'keys.json'), 'utf8'),
    ).online;
    expect(listed).toHaveLength(2);
    expect(
      keys('revoke', '--root', join(work, 'offline', 'root-1.key'), '--key-id', listed[0].key_id)
        .code,
    ).toBe(0);
    expect(
      keys('sign-keys', '--root', join(work, 'offline', 'root-1.key'), '--keys-days', '121').out,
    ).toContain('at most 120 days');
    expect(keys('sign-keys', '--root', join(work, 'offline', 'root-1.key')).code).toBe(0);
    expect(version()).toBe(before + 3);
    // The secret file is never overwritten.
    expect(
      keys(
        'online-key',
        '--root',
        join(work, 'offline', 'root-1.key'),
        '--secret-out',
        join(work, 'offline', 'next.secret'),
      ).code,
    ).toBe(1);
    const status = run(process.execPath, [
      join(REPO, 'scripts', 'registry-keys.ts'),
      'status',
      '--repo',
      repo,
    ]);
    expect(status.out).toContain(`keys.json version ${before + 3}`);
    git('checkout', '-q', '--', 'registry/keys');
  });

  it('never writes a private key inside a git working tree', () => {
    const passFile = join(work, 'pass.txt');
    writeFileSync(passFile, `${PASS}\n`);
    const inside = join(repo, 'keys-here');
    const result = run(process.execPath, [
      join(REPO, 'scripts', 'registry-keys.ts'),
      'init-roots',
      '--out',
      inside,
      '--repo',
      repo,
      '--passphrase-file',
      passFile,
    ]);
    expect(result.code).toBe(1);
    expect(result.out).toContain('inside a git working tree');
  });
});
