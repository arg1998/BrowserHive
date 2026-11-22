#!/usr/bin/env node
// @ts-check
/**
 * @module scripts/registry-sign — the site-pack registry's signing step (spec 13 §10.2, §10.7). It
 * runs in the `registry-signing` environment without installing dependencies (`node` and the
 * checked-out commit only), recomputes from the commit's `registry/` (archive included) every pack
 * file and the unsigned index the build job produced, refuses on any difference, checks the
 * published layout (D-81: verified against the pinned roots and the commit's online keys, its
 * version not below what `registry/state.json` and GitHub's copy of the last signature know and
 * within the fast-forward bound, issued within 15 days unless it is that last signature, its
 * published versions unchanged), and only then signs `index.json` with the online key from
 * `REGISTRY_ONLINE_KEY`.
 * Commands:
 *
 *   sign  --artefact <dir> --out <dir> --previous <dir> [--last-signed <dir>] [--first-publish]
 *         [--checksums <file>]
 *   sign  --artefact <dir> --out <dir> --test-keys <dir>    pull-request previews: a throwaway root
 *                                                           and online key no release trusts
 *   fetch --url <base> --out <dir> [--packs]                download the published layout
 *   carry --from <dir> --out <dir> [--last-signed <dir>]    the registry a deploy that does not sign
 *                                                           ships: the live one if this commit stands
 *                                                           behind it, else GitHub's last signature,
 *                                                           else refuse (see carryCommand)
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
  fsReader,
  generateKey,
  INDEX_FAST_FORWARD,
  INDEX_LIFETIME_MS,
  INDEX_MAX_BYTES,
  instant,
  PACK_MAX_BYTES,
  privateKeyFromPkcs8,
  rawPublicKey,
  readRootKeys,
  readState,
  SECRET_PREFIX,
  sha256Hex,
  signatureFile,
  verifiedBy,
} from './registry-common.mjs';

const LAYOUT_FILES = ['keys.json', 'keys.json.sig', 'index.json', 'index.json.sig'];
const NOTHING_PUBLISHED = '.nothing-published';
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
 * @typedef {{ version: number, expires: string, online: { key_id: string, public_key: string,
 *   not_after: string }[] }} KeysDoc
 * @typedef {{ version: number, issued_at: string, expires: string, packs: { id: string,
 *   versions: { v: number, sha256: string, size: number, path: string, min_client: string,
 *   max_client?: string }[] }[] }} IndexDoc
 */

/** @param {Buffer} bytes @param {string} what @returns {any} */
function jsonOf(bytes, what) {
  try {
    return JSON.parse(bytes.toString('utf8'));
  } catch {
    return refuse(`${what} is not JSON`);
  }
}

/** The commit's `registry/keys/keys.json`, verified against the roots. @param {string} repo */
function commitKeys(repo) {
  const roots = rootsOf(repo);
  const path = join(repo, 'registry', 'keys', 'keys.json');
  if (!existsSync(path))
    refuse('registry/keys/keys.json is missing: run registry-keys.mjs online-key');
  const bytes = readFileSync(path);
  const sig = existsSync(`${path}.sig`) ? readFileSync(`${path}.sig`, 'utf8') : '';
  if (verifiedBy(bytes, sig, roots) === null)
    refuse('registry/keys/keys.json: no root signature verifies');
  /** @type {KeysDoc} */
  const keys = jsonOf(bytes, 'registry/keys/keys.json');
  if (!Number.isSafeInteger(keys.version) || !Array.isArray(keys.online))
    refuse('registry/keys/keys.json: not a keys file');
  return { roots, bytes, sig, keys };
}

/** @param {string} repo */
function recordedVersion(repo) {
  const state = readState(fsReader(repo));
  if (state === null) refuse('registry/state.json is missing or malformed');
  return state.index_version;
}

/** A published index older than this may be a replayed old copy (14 days of life + a day). */
const STALE_MS = 15 * DAY_MS;

/**
 * @typedef {{ keysBytes: Buffer, keys: KeysDoc, index: IndexDoc, signedBy: string,
 *   supersededSigner: boolean }} Published
 */

/**
 * A published layout in `dir` (the live site's, or GitHub's copy of the last signature), checked
 * as the signing and carry steps need it (review #97 M1, M4, R2): `keys.json` signed by a root and
 * not newer than the commit's, `index.json` signed by an online key **the commit's** `keys.json`
 * lists, or, with `allowSuperseded`, by one the published `keys.json` lists when the commit's
 * `keys.json` is newer (a rotation or an emergency revocation the commit carries), a safe-integer
 * version not below `floor` and within the fast-forward bound.
 *
 * @param {string} dir
 * @param {ReturnType<typeof commitKeys>} commit
 * @param {number} floor the highest index version known to be published
 * @param {{ allowSuperseded?: boolean, what?: string }} [options]
 * @returns {Published}
 */
function verifyPublished(dir, commit, floor, options = {}) {
  const what = options.what ?? 'the published';
  const read = (/** @type {string} */ name) => readFileSync(join(dir, name));
  const keysBytes = read('keys.json');
  if (verifiedBy(keysBytes, read('keys.json.sig').toString('utf8'), commit.roots) === null) {
    refuse(`${what} keys.json: no root signature verifies`);
  }
  /** @type {KeysDoc} */
  const keys = jsonOf(keysBytes, `${what} keys.json`);
  if (
    !Number.isSafeInteger(keys.version) ||
    !Array.isArray(keys.online) ||
    keys.version > commit.keys.version
  ) {
    refuse(`${what} keys.json is version ${keys.version}, this commit's ${commit.keys.version}`);
  }
  const indexBytes = read('index.json');
  if (indexBytes.byteLength > INDEX_MAX_BYTES) refuse(`${what} index.json is too large`);
  const indexSig = read('index.json.sig').toString('utf8');
  const current = new Map(commit.keys.online.map((k) => [k.key_id, k.public_key]));
  let signedBy = verifiedBy(indexBytes, indexSig, current);
  let supersededSigner = false;
  if (signedBy === null && options.allowSuperseded === true && keys.version < commit.keys.version) {
    const older = new Map(keys.online.map((k) => [k.key_id, k.public_key]));
    signedBy = verifiedBy(indexBytes, indexSig, older);
    supersededSigner = signedBy !== null;
  }
  if (signedBy === null) {
    refuse(
      `${what} index.json is signed by no online key this commit's keys.json lists (a revoked key, or not ours): see docs/contributing/registry.md "If the published registry cannot be verified"`,
    );
  }
  /** @type {IndexDoc} */
  const index = jsonOf(indexBytes, `${what} index.json`);
  if (!Number.isSafeInteger(index.version) || index.version < 1 || !Array.isArray(index.packs)) {
    refuse(`${what} index.json has no valid version`);
  }
  if (index.version < floor) {
    refuse(
      `${what} index.json is version ${index.version}, below version ${floor} known to be published (a rollback)`,
    );
  }
  if (index.version > floor + INDEX_FAST_FORWARD) {
    refuse(
      `${what} index.json is version ${index.version}, more than ${INDEX_FAST_FORWARD} above version ${floor} known to be published (a fast-forward)`,
    );
  }
  return { keysBytes, keys, index, signedBy, supersededSigner };
}

/**
 * GitHub's copy of the last signature (the `registry-signed` artefact of the newest run on
 * `main`, downloaded by the workflow; review #97 M1): the floor the live site cannot lower.
 * `null` when `dir` holds none. Its chain must verify under the commit's roots.
 *
 * @param {string | true | undefined} dir
 * @param {ReturnType<typeof commitKeys>} commit
 */
function lastSignedOf(dir, commit) {
  if (typeof dir !== 'string' || !existsSync(join(resolve(dir), 'index.json'))) return null;
  const read = (/** @type {string} */ name) => readFileSync(join(resolve(dir), name));
  const keysBytes = read('keys.json');
  if (verifiedBy(keysBytes, read('keys.json.sig').toString('utf8'), commit.roots) === null) {
    refuse('the last signed layout (GitHub artefact): no root signature verifies');
  }
  /** @type {KeysDoc} */
  const keys = jsonOf(keysBytes, 'the last signed keys.json');
  const online = new Map((keys.online ?? []).map((k) => [k.key_id, k.public_key]));
  const indexBytes = read('index.json');
  const signedBy = verifiedBy(indexBytes, read('index.json.sig').toString('utf8'), online);
  if (signedBy === null)
    refuse('the last signed layout (GitHub artefact): its index does not verify');
  /** @type {IndexDoc} */
  const index = jsonOf(indexBytes, 'the last signed index.json');
  if (!Number.isSafeInteger(index.version) || index.version < 1)
    refuse('the last signed index.json has no valid version');
  return { dir: resolve(dir), keysBytes, keys, index, signedBy };
}

/** A published version may never change (M3): same sha, size and client range. @param {IndexDoc} live @param {import('./registry-common.mjs').UnsignedIndex} next */
function requireUnchangedVersions(live, next) {
  const now = new Map(next.packs.flatMap((p) => p.versions.map((v) => [`${p.id} v${v.v}`, v])));
  for (const pack of live.packs) {
    for (const was of pack.versions ?? []) {
      const is = now.get(`${pack.id} v${was.v}`);
      if (is === undefined) continue;
      if (
        is.sha256 !== was.sha256 ||
        is.size !== was.size ||
        is.min_client !== was.min_client ||
        is.max_client !== was.max_client
      ) {
        refuse(
          `${pack.id} v${was.v} is published with other content; a published version never changes`,
        );
      }
    }
  }
}

/** Every listed pack file of `dir` against its index entry. @param {string} dir @param {IndexDoc} index */
function verifyPackFiles(dir, index) {
  /** @type {string[]} */
  const paths = [];
  for (const pack of index.packs) {
    for (const entry of pack.versions) {
      if (
        !PACK_PATH_RE.test(entry.path) ||
        entry.path !== `packs/${pack.id}/${entry.sha256}.json`
      ) {
        refuse(`the published index.json: bad path ${entry.path}`);
      }
      const file = join(dir, entry.path);
      if (!existsSync(file)) refuse(`the published ${entry.path} is missing`);
      const bytes = readFileSync(file);
      if (bytes.byteLength !== entry.size || sha256Hex(bytes) !== entry.sha256) {
        refuse(`the published ${entry.path}: size or SHA-256 differs from the index`);
      }
      paths.push(entry.path);
    }
  }
  return paths;
}

/** The online key from `REGISTRY_ONLINE_KEY` (`bhreg1.<key id>.<base64 PKCS#8>`), removed from the environment once read. */
function onlineKeyFromEnv() {
  const value = (process.env['REGISTRY_ONLINE_KEY'] ?? '').trim();
  delete process.env['REGISTRY_ONLINE_KEY'];
  if (value === '')
    refuse('REGISTRY_ONLINE_KEY is not set (the registry-signing environment secret)');
  const [prefix, keyId, b64] = value.split('.');
  if (prefix !== SECRET_PREFIX || keyId === undefined || b64 === undefined) {
    refuse('REGISTRY_ONLINE_KEY is not a value written by registry-keys.mjs online-key');
  }
  const privateKey = privateKeyFromPkcs8(Buffer.from(b64, 'base64'));
  return { privateKey, publicKey: rawPublicKey(privateKey), keyId };
}

/**
 * Diffs the build job's artefact against what the commit yields, file by file.
 *
 * @param {string} repo
 * @param {string} artefact
 */
function checkArtefact(repo, artefact) {
  const expected = collectRegistry(fsReader(repo));
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
      refuse(`the artefact ${path} differs from registry/archive at this commit`);
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
    const commit = commitKeys(repo);
    const expires = Date.parse(commit.keys.expires);
    if (!(expires > now + DAY_MS))
      refuse(`keys.json expires ${commit.keys.expires}: re-sign it (registry-keys.mjs sign-keys)`);
    if (expires < now + 21 * DAY_MS)
      console.warn(`::warning::keys.json expires ${commit.keys.expires}; re-sign it soon`);
    const online = onlineKeyFromEnv();
    const listed = commit.keys.online.find((k) => k.key_id === online.keyId);
    if (listed === undefined || listed.public_key !== online.publicKey) {
      refuse(`the online key ${online.keyId} is not listed in keys.json`);
    }
    const notAfter = Date.parse(listed.not_after);
    if (!(notAfter > now + DAY_MS))
      refuse(`the online key is valid until ${listed.not_after}: rotate it`);
    if (notAfter < now + 14 * DAY_MS)
      console.warn(`::warning::the online key is valid until ${listed.not_after}; rotate it`);
    const recorded = recordedVersion(repo);
    const last = lastSignedOf(flags['last-signed'], commit);
    const floor = Math.max(recorded, last?.index.version ?? 0);
    if (last !== null) requireUnchangedVersions(last.index, expected.index);
    const previous = resolve(required(flags, 'previous'));
    const present = LAYOUT_FILES.filter((f) => existsSync(join(previous, f)));
    let version;
    if (present.length === LAYOUT_FILES.length) {
      const published = verifyPublished(previous, commit, floor, { allowSuperseded: true });
      if (published.supersededSigner) {
        console.warn(
          `::warning::the published index is signed by ${published.signedBy}, which this commit's keys.json no longer lists (a rotation or revocation); it is replaced now`,
        );
      }
      // An old, validly signed copy must not set the counter back (review #97 M1).
      const issued = Date.parse(published.index.issued_at);
      const confirmed =
        published.index.version === recorded || published.index.version === last?.index.version;
      if (!(issued > now - STALE_MS) && !confirmed) {
        refuse(
          `the published index.json (version ${published.index.version}) was issued ${published.index.issued_at}, more than 15 days ago, and is not the last signature GitHub or registry/state.json knows: it may be an old copy. If it really is the latest, record ${published.index.version} in registry/state.json and run again`,
        );
      }
      requireUnchangedVersions(published.index, expected.index);
      version = Math.max(published.index.version, floor) + 1;
    } else if (present.length === 0 && flags['first-publish'] === true) {
      console.warn(`::warning::nothing is published; publishing as version ${floor + 1}`);
      version = floor + 1;
    } else if (present.length === 0) {
      refuse(
        `nothing is published${floor > 0 ? `, but version ${floor} is known to be published (registry/state.json or GitHub's last signature): the site lost its registry; restore it, or re-publish deliberately with first_publish` : ' yet: run the website workflow with first_publish for the first publication'}`,
      );
    } else {
      refuse(`the site publishes only ${present.join(', ')}`);
    }
    chain = { keysBytes: commit.bytes, keysSig: commit.sig, online, notAfter, version };
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
  summary(
    `### Site-pack registry\n\n${line}${typeof testDir === 'string' ? '' : ` Record it: set \`index_version\` in registry/state.json to ${index.version} in a later pull request.`}`,
  );
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
    // Every file answered 404: the site serves no registry (as opposed to a fetch that failed).
    writeOut(join(out, NOTHING_PUBLISHED), `${base}\n`);
    console.log(`nothing is published at ${base} yet`);
    return;
  }
  if (found.length !== LAYOUT_FILES.length) refuse(`${base} publishes only ${found.join(', ')}`);
  if (flags['packs'] !== true) return;
  const index = jsonOf(readFileSync(join(out, 'index.json')), 'index.json');
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

/** Copies a verified layout to `out`. @param {string} from @param {string} out @param {IndexDoc} index */
function copyLayout(from, out, index) {
  const packFiles = verifyPackFiles(from, index);
  for (const name of [...LAYOUT_FILES, ...packFiles])
    writeOut(join(out, name), readFileSync(join(from, name)));
}

/**
 * The registry a website deploy that does not sign ships (review #97 M4, R1), the first of:
 * 1. the live layout, when it is exactly this commit's (its `keys.json` byte for byte, a still
 *    valid online key of it): carried;
 * 2. the live layout, when it verifies with an online key the commit's `keys.json` still lists
 *    (an expired key, or a rotation whose re-sign is still waiting): kept as deployed, with a
 *    warning that a re-sign is needed;
 * 3. GitHub's copy of the last signature, when the site's copy cannot be fetched or verified and
 *    it verifies the same way: re-deployed;
 * 4. nothing, only when the site serves no registry and GitHub holds no signature.
 * Anything else refuses, and the deploy fails rather than ship the site without its registry or
 * with a layout the commit revoked.
 *
 * @param {Record<string, string | true>} flags @param {string} repo
 */
function carryCommand(flags, repo) {
  const from = resolve(required(flags, 'from'));
  const out = resolve(required(flags, 'out'));
  requireEmpty(out);
  const fetched = LAYOUT_FILES.every((f) => existsSync(join(from, f)));
  const nothing = existsSync(join(from, NOTHING_PUBLISHED));
  if (!fetched && nothing && flags['last-signed'] === undefined) {
    console.log('nothing is published yet; the site deploys without a registry');
    return;
  }
  const commit = commitKeys(repo);
  const last = lastSignedOf(flags['last-signed'], commit);
  const floor = Math.max(recordedVersion(repo), last?.index.version ?? 0);
  /** @type {string[]} */
  const reasons = [];
  if (fetched) {
    try {
      const live = verifyPublished(from, commit, floor);
      const signer = commit.keys.online.find((k) => k.key_id === live.signedBy);
      const current =
        live.keysBytes.equals(commit.bytes) &&
        signer !== undefined &&
        Date.parse(signer.not_after) > Date.now();
      copyLayout(from, out, live.index);
      if (current) {
        console.log(
          `carried index.json version ${live.index.version} over (expires ${live.index.expires})`,
        );
        summary(
          `### Site-pack registry\n\nCarried the published index.json version ${live.index.version} over unchanged (expires ${live.index.expires}).`,
        );
      } else {
        console.warn(
          `::warning::kept the published registry (index.json version ${live.index.version}) as deployed; it is not this commit's current signature: re-sign (run the website workflow with sign)`,
        );
        summary(
          `### Site-pack registry\n\nKept the published index.json version ${live.index.version} as deployed. **A re-sign is needed** (its keys.json or online key is not this commit's current one).`,
        );
      }
      if (Date.parse(live.index.expires) < Date.now() + 3 * DAY_MS) {
        console.warn(
          `::warning::the published index.json expires ${live.index.expires}; approve a re-sign (registry-resign)`,
        );
      }
      return;
    } catch (error) {
      if (!(error instanceof Refused)) throw error;
      reasons.push(`the live layout: ${error.message}`);
    }
  } else if (!nothing) {
    reasons.push('the live layout could not be fetched');
  }
  if (last !== null) {
    try {
      verifyPublished(last.dir, commit, floor, { what: 'the last signed' });
      copyLayout(last.dir, out, last.index);
      console.warn(
        `::warning::re-deployed GitHub's copy of the last signature (index.json version ${last.index.version}): ${reasons.join('; ') || 'the site serves no registry'}`,
      );
      summary(
        `### Site-pack registry\n\nRe-deployed the last signed index.json version ${last.index.version} from GitHub (${reasons.join('; ') || 'the site served none'}).`,
      );
      return;
    } catch (error) {
      if (!(error instanceof Refused)) throw error;
      reasons.push(`GitHub's last signature: ${error.message}`);
    }
  }
  if (!fetched && nothing && last === null) {
    console.log('nothing is published yet; the site deploys without a registry');
    return;
  }
  refuse(
    `no registry can be deployed unchanged, so the deploy stops (the site keeps what it serves): ${reasons.join('; ')}. Re-sign: run the website workflow with sign`,
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
