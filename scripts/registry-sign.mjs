#!/usr/bin/env node
// @ts-check
/**
 * @module scripts/registry-sign — the site-pack registry's signing step (spec 13 §10.2, §10.7). It
 * runs in the `registry-signing` environment without installing dependencies (`node`, the checked-out
 * commit and `git` only), recomputes from the commit every pack file and the unsigned index the
 * build job produced, refuses on any difference, and only then signs `index.json` with the online
 * key from `REGISTRY_ONLINE_KEY`. Commands:
 *
 *   sign  --artefact <dir> --out <dir> --previous <dir> [--checksums <file>]
 *   sign  --artefact <dir> --out <dir> --test-keys <dir>    pull-request previews: a throwaway root
 *                                                           and online key no release trusts
 *   fetch --url <base> --out <dir> [--packs]                download the published layout
 *   carry --from <dir> --out <dir>                          verify a downloaded layout and copy it
 *                                                           (a website deploy that does not re-sign)
 *
 * Every command takes `--repo <dir>` (default: this script's repository).
 */
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  canonicalJson,
  collectRegistry,
  DAY_MS,
  generateKey,
  INDEX_LIFETIME_MS,
  INDEX_MAX_BYTES,
  instant,
  PACK_MAX_BYTES,
  privateKeyFromPkcs8,
  rawPublicKey,
  readRootKeys,
  requireFullHistory,
  SECRET_PREFIX,
  sha256Hex,
  signatureFile,
  verifiedBy,
} from './registry-common.mjs';

const LAYOUT_FILES = ['keys.json', 'keys.json.sig', 'index.json', 'index.json.sig'];
const PACK_PATH_RE = /^packs\/[a-z0-9.-]{4,253}\/[0-9a-f]{64}\.json$/;

class Refused extends Error {}

/** @param {string} message @returns {never} */
function refuse(message) {
  throw new Refused(message);
}

/** @param {string[]} argv */
function parseArgs(argv) {
  /** @type {Record<string, string | true>} */
  const flags = {};
  const [command, ...rest] = argv;
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i] ?? '';
    if (!arg.startsWith('--')) refuse(`unexpected argument ${arg}`);
    const next = rest[i + 1];
    if (next === undefined || next.startsWith('--')) flags[arg.slice(2)] = true;
    else {
      flags[arg.slice(2)] = next;
      i += 1;
    }
  }
  return { command, flags };
}

/** @param {Record<string, string | true>} flags @param {string} name @returns {string} */
function required(flags, name) {
  const value = flags[name];
  if (typeof value !== 'string') refuse(`--${name} <value> is required`);
  return value;
}

/** Every file under `dir`, relative, POSIX. @param {string} dir @returns {string[]} */
function filesUnder(dir) {
  /** @type {string[]} */
  const out = [];
  const walk = (/** @type {string} */ at) => {
    for (const entry of readdirSync(at, { withFileTypes: true })) {
      const full = join(at, entry.name);
      if (entry.isDirectory()) walk(full);
      else out.push(relative(dir, full).split('\\').join('/'));
    }
  };
  if (existsSync(dir)) walk(dir);
  return out.sort();
}

/** @param {string} dir */
function requireEmpty(dir) {
  if (existsSync(dir) && readdirSync(dir).length > 0) refuse(`${dir} is not empty`);
}

/** @param {string} path @param {string | Uint8Array} data */
function writeOut(path, data) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, data);
}

/** @param {string} line */
function summary(line) {
  const file = process.env['GITHUB_STEP_SUMMARY'];
  if (file !== undefined && file !== '') appendFileSync(file, `${line}\n`);
}

/** @param {string} repo */
function rootsOf(repo) {
  const roots = readRootKeys(join(repo, 'registry', 'keys'));
  if (roots.placeholder) {
    refuse(
      'registry/keys/root-*.pub are placeholders: the key ceremony has not run (docs/contributing/registry.md)',
    );
  }
  if (roots.problems.length > 0) refuse(`registry/keys: ${roots.problems.join('; ')}`);
  if (roots.test)
    refuse('registry/keys holds a test root key; a published registry needs the real ones');
  if (roots.keys.length !== 2) refuse('registry/keys needs root-1.pub and root-2.pub');
  return new Map(roots.keys.map((k) => [k.key_id, k.public_key]));
}

/**
 * Checks a layout's chain (`keys.json` by a root, `index.json` by one of its online keys) and every
 * listed pack file. Clocks are not checked: this is about what was published, not whether a client
 * would still accept it today.
 *
 * @param {string} dir
 * @param {ReadonlyMap<string, string>} roots
 * @param {boolean} withPacks whether the pack files are there to check
 */
function verifyPublished(dir, roots, withPacks) {
  const read = (/** @type {string} */ name) => readFileSync(join(dir, name));
  const keysBytes = read('keys.json');
  if (verifiedBy(keysBytes, read('keys.json.sig').toString('utf8'), roots) === null) {
    refuse(`${dir}/keys.json: no root signature verifies`);
  }
  const keys = JSON.parse(keysBytes.toString('utf8'));
  /** @type {Map<string, string>} */
  const online = new Map(keys.online.map((/** @type {any} */ k) => [k.key_id, k.public_key]));
  const indexBytes = read('index.json');
  if (indexBytes.byteLength > INDEX_MAX_BYTES) refuse(`${dir}/index.json is too large`);
  if (verifiedBy(indexBytes, read('index.json.sig').toString('utf8'), online) === null) {
    refuse(`${dir}/index.json: no signature of an online key of keys.json verifies`);
  }
  const index = JSON.parse(indexBytes.toString('utf8'));
  /** @type {string[]} */
  const packFiles = [];
  for (const pack of withPacks ? index.packs : []) {
    for (const entry of pack.versions) {
      if (
        !PACK_PATH_RE.test(entry.path) ||
        entry.path !== `packs/${pack.id}/${entry.sha256}.json`
      ) {
        refuse(`${dir}/index.json: bad path ${entry.path}`);
      }
      const file = join(dir, entry.path);
      if (!existsSync(file)) refuse(`${dir}/${entry.path} is missing`);
      const bytes = readFileSync(file);
      if (bytes.byteLength !== entry.size || sha256Hex(bytes) !== entry.sha256) {
        refuse(`${dir}/${entry.path}: size or SHA-256 differs from the index`);
      }
      packFiles.push(entry.path);
    }
  }
  return { keys, index, packFiles };
}

/** The online key from `REGISTRY_ONLINE_KEY` (`bhreg1.<key id>.<base64 PKCS#8>`). */
function onlineKeyFromEnv() {
  const value = (process.env['REGISTRY_ONLINE_KEY'] ?? '').trim();
  if (value === '')
    refuse('REGISTRY_ONLINE_KEY is not set (the registry-signing environment secret)');
  const [prefix, keyId, b64] = value.split('.');
  if (prefix !== SECRET_PREFIX || keyId === undefined || b64 === undefined) {
    refuse('REGISTRY_ONLINE_KEY is not a value written by registry-keys.ts online-key');
  }
  const privateKey = privateKeyFromPkcs8(Buffer.from(b64, 'base64'));
  const publicKey = rawPublicKey(privateKey);
  return { privateKey, publicKey, keyId };
}

/**
 * Diffs the build job's artefact against what the commit yields, file by file.
 *
 * @param {string} repo
 * @param {string} artefact
 */
function checkArtefact(repo, artefact) {
  requireFullHistory(repo);
  const expected = collectRegistry(repo);
  if (expected.problems.length > 0) refuse(`registry/: ${expected.problems.join('; ')}`);
  const indexText = canonicalJson(expected.index);
  const artefactIndex = join(artefact, 'index.json');
  if (!existsSync(artefactIndex) || readFileSync(artefactIndex, 'utf8') !== indexText) {
    refuse('the artefact index.json differs from the one this commit yields');
  }
  const keyFiles = ['keys.json', 'keys.json.sig'].filter((f) =>
    existsSync(join(repo, 'registry', 'keys', f)),
  );
  const allowed = new Set(['index.json', ...keyFiles, ...expected.files.keys()]);
  for (const file of filesUnder(artefact)) {
    if (!allowed.has(file)) refuse(`the artefact holds ${file}, which this commit does not yield`);
  }
  for (const [path, bytes] of expected.files) {
    const file = join(artefact, path);
    if (!existsSync(file) || !readFileSync(file).equals(bytes)) {
      refuse(`the artefact ${path} differs from registry/packs at this commit`);
    }
  }
  for (const name of keyFiles) {
    if (
      !readFileSync(join(artefact, name)).equals(readFileSync(join(repo, 'registry', 'keys', name)))
    ) {
      refuse(`the artefact ${name} differs from registry/keys/${name}`);
    }
  }
  return expected;
}

/** @param {Record<string, string | true>} flags @param {string} repo */
function signCommand(flags, repo) {
  const artefact = resolve(required(flags, 'artefact'));
  const out = resolve(required(flags, 'out'));
  requireEmpty(out);
  const expected = checkArtefact(repo, artefact);
  const now = Date.now();
  const testDir = flags['test-keys'];
  /** @type {{ keysBytes: Buffer, keysSig: string, online: { privateKey: import('node:crypto').KeyObject, publicKey: string, keyId: string }, notAfter: number, version: number }} */
  let chain;
  if (typeof testDir === 'string') {
    const root = generateKey();
    const online = generateKey();
    const notAfter = now + 7 * DAY_MS;
    const keys = {
      schema: 1,
      version: 1,
      expires: instant(now + 7 * DAY_MS),
      online: [
        { key_id: online.keyId, public_key: online.publicKey, not_after: instant(notAfter) },
      ],
    };
    const keysBytes = Buffer.from(canonicalJson(keys));
    writeOut(
      join(resolve(testDir), 'test-root.pub'),
      canonicalJson({
        schema: 1,
        role: 'root',
        slot: 1,
        key_id: root.keyId,
        public_key: root.publicKey,
        test: true,
        note: 'A throwaway test root of a pull-request preview. No release trusts it.',
      }),
    );
    chain = { keysBytes, keysSig: signatureFile(keysBytes, [root]), online, notAfter, version: 1 };
  } else {
    const roots = rootsOf(repo);
    const keysPath = join(repo, 'registry', 'keys', 'keys.json');
    if (!existsSync(keysPath))
      refuse('registry/keys/keys.json is missing: run registry-keys.ts online-key');
    const keysBytes = readFileSync(keysPath);
    const keysSig = readFileSync(`${keysPath}.sig`, 'utf8');
    if (verifiedBy(keysBytes, keysSig, roots) === null)
      refuse('registry/keys/keys.json: no root signature verifies');
    const keys = JSON.parse(keysBytes.toString('utf8'));
    const expires = Date.parse(keys.expires);
    if (!(expires > now + DAY_MS))
      refuse(`keys.json expires ${keys.expires}: re-sign it (registry-keys.ts sign-keys)`);
    if (expires < now + 21 * DAY_MS)
      console.warn(`::warning::keys.json expires ${keys.expires}; re-sign it soon`);
    const online = onlineKeyFromEnv();
    const listed = keys.online.find((/** @type {any} */ k) => k.key_id === online.keyId);
    if (listed === undefined || listed.public_key !== online.publicKey) {
      refuse(`the online key ${online.keyId} is not listed in keys.json`);
    }
    const notAfter = Date.parse(listed.not_after);
    if (!(notAfter > now + DAY_MS))
      refuse(`the online key is valid until ${listed.not_after}: rotate it`);
    if (notAfter < now + 14 * DAY_MS)
      console.warn(`::warning::the online key is valid until ${listed.not_after}; rotate it`);
    const previous = resolve(required(flags, 'previous'));
    let version = 1;
    if (existsSync(join(previous, 'index.json'))) {
      const published = verifyPublished(previous, roots, false);
      if (published.keys.version > keys.version) {
        refuse(
          `the published keys.json is version ${published.keys.version}, this commit's ${keys.version}`,
        );
      }
      version = Number(published.index.version) + 1;
    } else {
      console.warn('::warning::no index.json is published yet; this is version 1');
    }
    chain = { keysBytes, keysSig, online, notAfter, version };
  }
  const index = {
    schema: 1,
    version: chain.version,
    issued_at: instant(now),
    expires: instant(Math.min(now + INDEX_LIFETIME_MS, chain.notAfter - 1000)),
    packs: expected.index.packs,
  };
  const indexBytes = Buffer.from(canonicalJson(index));
  if (indexBytes.byteLength > INDEX_MAX_BYTES)
    refuse(`index.json is ${indexBytes.byteLength} bytes`);
  const indexSig = signatureFile(indexBytes, [chain.online]);
  if (
    verifiedBy(indexBytes, indexSig, new Map([[chain.online.keyId, chain.online.publicKey]])) ===
    null
  ) {
    refuse('the new signature does not verify');
  }
  writeOut(join(out, 'keys.json'), chain.keysBytes);
  writeOut(join(out, 'keys.json.sig'), chain.keysSig);
  writeOut(join(out, 'index.json'), indexBytes);
  writeOut(join(out, 'index.json.sig'), indexSig);
  for (const [path, bytes] of expected.files) writeOut(join(out, path), bytes);
  const checksums = flags['checksums'];
  if (typeof checksums === 'string') {
    const lines = filesUnder(out).map((f) => `${sha256Hex(readFileSync(join(out, f)))}  ${f}`);
    writeOut(resolve(checksums), `${lines.join('\n')}\n`);
  }
  const versions = expected.index.packs.reduce((n, p) => n + p.versions.length, 0);
  const mode =
    typeof testDir === 'string' ? 'a throwaway test key' : `online key ${chain.online.keyId}`;
  const line = `Signed index.json version ${index.version} (${expected.index.packs.length} packs, ${versions} versions) with ${mode}; expires ${index.expires}.`;
  console.log(line);
  summary(`### Site-pack registry\n\n${line}`);
}

/** @param {string} url @param {number} max @returns {Promise<Buffer | null>} */
async function get(url, max) {
  const response = await fetch(url, {
    headers: { 'user-agent': 'BrowserHive registry publishing' },
    redirect: 'error',
    signal: AbortSignal.timeout(30_000),
  });
  if (response.status === 404) return null;
  if (response.status !== 200) refuse(`${url} answered ${response.status}`);
  const body = Buffer.from(await response.arrayBuffer());
  if (body.byteLength > max) refuse(`${url} is larger than ${max} bytes`);
  return body;
}

/** @param {Record<string, string | true>} flags */
async function fetchCommand(flags) {
  const base = required(flags, 'url');
  if (!base.startsWith('https://') || !base.endsWith('/'))
    refuse('--url must be https:// and end with /');
  const out = resolve(required(flags, 'out'));
  requireEmpty(out);
  mkdirSync(out, { recursive: true });
  const found = [];
  for (const name of LAYOUT_FILES) {
    const body = await get(new URL(name, base).href, INDEX_MAX_BYTES);
    if (body !== null) {
      writeOut(join(out, name), body);
      found.push(name);
    }
  }
  if (found.length === 0) {
    console.log(`nothing is published at ${base} yet`);
    return;
  }
  if (found.length !== LAYOUT_FILES.length) refuse(`${base} publishes only ${found.join(', ')}`);
  if (flags['packs'] !== true) return;
  const index = JSON.parse(readFileSync(join(out, 'index.json'), 'utf8'));
  for (const pack of index.packs ?? []) {
    for (const entry of pack.versions ?? []) {
      if (typeof entry.path !== 'string' || !PACK_PATH_RE.test(entry.path))
        refuse(`bad path ${entry.path}`);
      const body = await get(new URL(entry.path, base).href, PACK_MAX_BYTES);
      if (body === null) refuse(`${entry.path} is listed but not published`);
      writeOut(join(out, entry.path), body);
    }
  }
  console.log(`fetched the layout published at ${base}`);
}

/** @param {Record<string, string | true>} flags @param {string} repo */
function carryCommand(flags, repo) {
  const from = resolve(required(flags, 'from'));
  const out = resolve(required(flags, 'out'));
  requireEmpty(out);
  if (!existsSync(join(from, 'index.json'))) {
    console.log('nothing is published yet; the site deploys without a registry');
    return;
  }
  const { index, packFiles } = verifyPublished(from, rootsOf(repo), true);
  for (const name of [...LAYOUT_FILES, ...packFiles])
    writeOut(join(out, name), readFileSync(join(from, name)));
  const expires = Date.parse(index.expires);
  if (expires < Date.now() + 3 * DAY_MS) {
    console.warn(
      `::warning::the published index.json expires ${index.expires}; approve a re-sign (registry-resign)`,
    );
  }
  console.log(`carried index.json version ${index.version} over (expires ${index.expires})`);
  summary(
    `### Site-pack registry\n\nCarried the published index.json version ${index.version} over unchanged (expires ${index.expires}).`,
  );
}

async function main() {
  const { command, flags } = parseArgs(process.argv.slice(2));
  const here = dirname(fileURLToPath(import.meta.url));
  const repo = resolve(typeof flags['repo'] === 'string' ? flags['repo'] : join(here, '..'));
  if (command === 'sign') signCommand(flags, repo);
  else if (command === 'fetch') await fetchCommand(flags);
  else if (command === 'carry') carryCommand(flags, repo);
  else refuse('usage: registry-sign.mjs sign|fetch|carry … (see the header of this file)');
}

main().catch((error) => {
  const message = error instanceof Refused ? error.message : String(error?.stack ?? error);
  console.error(`registry-sign: refused: ${message}`);
  process.exit(1);
});
