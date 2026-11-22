#!/usr/bin/env node
// @ts-check
/**
 * @module scripts/registry-last-signed — GitHub's copy of the last registry signature (review #97
 * M1, R1; verification #99 N1, N4): the newest unexpired `registry-signed` artefact uploaded by a
 * run of **this** repository's `website.yml` or `registry-resign.yml` on `main`, started by `push`,
 * `schedule` or `workflow_dispatch`, that succeeded. Artefacts of pull requests (forks included)
 * never qualify. The zip is unpacked by hand, regular files only (no symlinks, no `..`, no
 * absolute paths). It is only a floor and a fallback: `registry-sign.mjs` verifies it against the
 * pinned roots before using it. Dependency-free: `node:fs`, `node:path`, `node:zlib` and `fetch`.
 *
 *   node scripts/registry-last-signed.mjs --out <dir> [--repo owner/name] [--api <url>]
 *
 * Reads `GH_TOKEN` (or `GITHUB_TOKEN`) with `actions: read` and `GITHUB_REPOSITORY`. Leaves `<dir>`
 * empty when there is none; exits 1 when the GitHub API cannot be read.
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { inflateRawSync } from 'node:zlib';

const NAME = 'registry-signed';
const WORKFLOWS = new Set([
  '.github/workflows/website.yml',
  '.github/workflows/registry-resign.yml',
]);
const EVENTS = new Set(['push', 'schedule', 'workflow_dispatch']);
const MAX_PAGES = 20;
const MAX_CANDIDATES = 30;
const MAX_ENTRIES = 2000;
const MAX_TOTAL = 16 * 1024 * 1024;
const SAFE_NAME = /^(?:[A-Za-z0-9._-]+\/)*[A-Za-z0-9._-]+$/;

/**
 * Unpacks a zip archive's regular files into `out`. Refuses symlinks and other special entries
 * (by their Unix mode), unsafe names, encryption, ZIP64 and oversized content.
 *
 * @param {Uint8Array} zip
 * @param {string} out
 * @returns {string[]} the files written, relative
 */
export function unzipRegular(zip, out) {
  const buf = Buffer.from(zip);
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65_557); i -= 1) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('not a zip archive');
  const count = buf.readUInt16LE(eocd + 10);
  let at = buf.readUInt32LE(eocd + 16);
  if (count > MAX_ENTRIES || at === 0xffffffff)
    throw new Error('unsupported zip (too many entries or ZIP64)');
  /** @type {string[]} */
  const written = [];
  let total = 0;
  for (let n = 0; n < count; n += 1) {
    if (buf.readUInt32LE(at) !== 0x02014b50) throw new Error('corrupt zip central directory');
    const madeBy = buf.readUInt16LE(at + 4) >> 8;
    const flags = buf.readUInt16LE(at + 8);
    const method = buf.readUInt16LE(at + 10);
    const compressed = buf.readUInt32LE(at + 20);
    const size = buf.readUInt32LE(at + 24);
    const nameLength = buf.readUInt16LE(at + 28);
    const extraLength = buf.readUInt16LE(at + 30);
    const commentLength = buf.readUInt16LE(at + 32);
    const external = buf.readUInt32LE(at + 38);
    const local = buf.readUInt32LE(at + 42);
    const name = buf.subarray(at + 46, at + 46 + nameLength).toString('utf8');
    at += 46 + nameLength + extraLength + commentLength;
    if (name.endsWith('/')) continue; // a directory entry
    const mode = (external >>> 16) & 0o170000;
    if (madeBy === 3 && mode !== 0 && mode !== 0o100000)
      throw new Error(`${name}: not a regular file`);
    if ((external & 0x10) !== 0) throw new Error(`${name}: not a regular file`);
    if (!SAFE_NAME.test(name) || name.split('/').some((p) => p === '..' || p === '.')) {
      throw new Error(`unsafe name in the archive: ${JSON.stringify(name)}`);
    }
    if ((flags & 0x1) !== 0 || compressed === 0xffffffff || size === 0xffffffff) {
      throw new Error(`${name}: encrypted or ZIP64 entries are not supported`);
    }
    total += size;
    if (total > MAX_TOTAL) throw new Error('the archive is too large');
    if (buf.readUInt32LE(local) !== 0x04034b50) throw new Error('corrupt zip local header');
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const data = buf.subarray(start, start + compressed);
    let bytes;
    if (method === 0) bytes = data;
    else if (method === 8) bytes = inflateRawSync(data, { maxOutputLength: size + 1 });
    else throw new Error(`${name}: compression method ${method} is not supported`);
    if (bytes.byteLength !== size) throw new Error(`${name}: size mismatch`);
    const file = join(out, ...name.split('/'));
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, bytes, { flag: 'wx' });
    written.push(name);
  }
  return written;
}

/**
 * @typedef {{ id: number, expired: boolean, created_at: string, workflow_run?: { id: number,
 *   head_branch?: string, repository_id?: number, head_repository_id?: number } }} Artifact
 */

/**
 * The newest artefact of a qualifying run, or `null`.
 *
 * @param {(path: string) => Promise<any>} api GET of a GitHub API path, JSON
 * @param {string} repo `owner/name`
 * @returns {Promise<Artifact | null>}
 */
export async function findLastSigned(api, repo) {
  /** @type {Artifact[]} */
  const all = [];
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const body = await api(
      `/repos/${repo}/actions/artifacts?name=${NAME}&per_page=100&page=${page}`,
    );
    const items = Array.isArray(body?.artifacts) ? body.artifacts : [];
    all.push(...items);
    if (items.length < 100) break;
  }
  const candidates = all
    .filter(
      (a) =>
        a.expired === false &&
        a.workflow_run?.head_branch === 'main' &&
        a.workflow_run.head_repository_id !== undefined &&
        a.workflow_run.head_repository_id === a.workflow_run.repository_id,
    )
    .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))
    .slice(0, MAX_CANDIDATES);
  for (const artifact of candidates) {
    const run = await api(`/repos/${repo}/actions/runs/${artifact.workflow_run?.id}`);
    const path = String(run?.path ?? '').split('@')[0] ?? '';
    if (
      EVENTS.has(run?.event) &&
      WORKFLOWS.has(path) &&
      run?.head_branch === 'main' &&
      run?.head_repository?.full_name === repo &&
      run?.repository?.full_name === repo &&
      run?.conclusion === 'success'
    ) {
      return artifact;
    }
  }
  return null;
}

async function main() {
  const args = process.argv.slice(2);
  const flag = (/** @type {string} */ name) => {
    const i = args.indexOf(`--${name}`);
    return i < 0 ? null : (args[i + 1] ?? null);
  };
  const out = resolve(flag('out') ?? '');
  const repo = flag('repo') ?? process.env['GITHUB_REPOSITORY'] ?? '';
  const base = (flag('api') ?? 'https://api.github.com').replace(/\/$/, '');
  const token = process.env['GH_TOKEN'] ?? process.env['GITHUB_TOKEN'] ?? '';
  if (flag('out') === null || !/^[\w.-]+\/[\w.-]+$/.test(repo)) {
    throw new Error(
      'usage: registry-last-signed.mjs --out <dir> [--repo owner/name] [--api <url>]',
    );
  }
  const headers = {
    accept: 'application/vnd.github+json',
    'user-agent': 'BrowserHive registry publishing',
    ...(token !== '' && { authorization: `Bearer ${token}` }),
  };
  const get = async (/** @type {string} */ path) => {
    const response = await fetch(`${base}${path}`, {
      headers,
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new Error(`${path} answered ${response.status}`);
    return response;
  };
  mkdirSync(out, { recursive: true });
  const artifact = await findLastSigned(async (path) => (await get(path)).json(), repo);
  if (artifact === null) {
    console.log('no registry signature of a run on main is stored on GitHub');
    return;
  }
  const zip = new Uint8Array(
    await (await get(`/repos/${repo}/actions/artifacts/${artifact.id}/zip`)).arrayBuffer(),
  );
  let files;
  try {
    files = unzipRegular(zip, out);
  } catch (error) {
    // Nothing half-written is left behind for the signing or deploy step to read.
    rmSync(out, { recursive: true, force: true });
    mkdirSync(out, { recursive: true });
    throw error;
  }
  console.log(
    `last signature: artefact ${artifact.id} of run ${artifact.workflow_run?.id} (${files.length} files)`,
  );
}

if (
  process.argv[1] !== undefined &&
  resolve(process.argv[1]).endsWith('registry-last-signed.mjs')
) {
  main().catch((error) => {
    console.error(
      `registry-last-signed: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(1);
  });
}
