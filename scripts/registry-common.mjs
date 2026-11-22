// @ts-check
/**
 * @module scripts/registry-common — the site-pack registry's shared, dependency-free producer code
 * (spec 13 §10.1, §10.2, §10.7): canonical JSON, Ed25519 with `node:crypto`, the root public keys
 * in `registry/keys/`, and the deterministic assembly of the unsigned index from `registry/` and
 * its git history. `registry-build.ts` (with dependencies) and `registry-sign.mjs` (without) both
 * call `collectRegistry`, so the signing job recomputes from the commit exactly what the build
 * produced and can diff the two. Imports only `node:crypto`, `node:fs`, `node:path` and
 * `node:child_process` (to read earlier versions with the `git` the checkout already uses).
 */
import { execFileSync } from 'node:child_process';
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign,
  verify,
} from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export const DAY_MS = 24 * 3_600_000;
/** `index.json.expires` is at most this long after `issued_at`. */
export const INDEX_LIFETIME_MS = 14 * DAY_MS;
/** `keys.json.expires` is at most this far ahead. */
export const KEYS_MAX_DAYS = 120;
/** An online key's `not_after` is at most this long after it was added. */
export const ONLINE_KEY_MAX_DAYS = 90;
/** Listed versions per pack. */
export const MAX_VERSIONS = 10;
/** Caps (equal to the client's, `@browserhive/contracts/site-packs`). */
export const PACK_MAX_BYTES = 64 * 1024;
export const INDEX_MAX_BYTES = 256 * 1024;
export const NOTES_MAX = 500;
/** The default published location of the layout. */
export const REGISTRY_URL = 'https://browserhive.ai/registry/v1/';
/** Prefix of the `REGISTRY_ONLINE_KEY` secret value. */
export const SECRET_PREFIX = 'bhreg1';

const SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

/**
 * Canonical JSON: keys sorted at every level, two-space indentation, a final newline.
 *
 * @param {unknown} value
 * @returns {string}
 */
export function canonicalJson(value) {
  return `${JSON.stringify(sortKeys(value), null, 2)}\n`;
}

/** @param {unknown} value @returns {unknown} */
function sortKeys(value) {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === 'object') {
    /** @type {Record<string, unknown>} */
    const out = {};
    for (const key of Object.keys(value).sort()) {
      out[key] = sortKeys(/** @type {Record<string, unknown>} */ (value)[key]);
    }
    return out;
  }
  return value;
}

/** @param {Uint8Array} bytes @returns {string} */
export function sha256Hex(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

/** `2026-11-22T10:00:00Z` (seconds, UTC). @param {number} ms @returns {string} */
export function instant(ms) {
  return `${new Date(Math.floor(ms / 1000) * 1000).toISOString().slice(0, 19)}Z`;
}

/** The key id of a base64 raw public key. @param {string} publicKey @returns {string} */
export function keyIdOf(publicKey) {
  return createHash('sha256').update(Buffer.from(publicKey, 'base64')).digest('hex').slice(0, 16);
}

/** @param {import('node:crypto').KeyObject} key @returns {string} the raw public key, base64 */
export function rawPublicKey(key) {
  const pub = key.type === 'private' ? createPublicKey(key) : key;
  return Buffer.from(pub.export({ format: 'der', type: 'spki' }))
    .subarray(12)
    .toString('base64');
}

/** @param {string} publicKey base64 raw @returns {import('node:crypto').KeyObject} */
export function publicKeyObject(publicKey) {
  const raw = Buffer.from(publicKey, 'base64');
  if (raw.byteLength !== 32) throw new Error('an Ed25519 public key is 32 bytes');
  return createPublicKey({
    key: Buffer.concat([SPKI_PREFIX, raw]),
    format: 'der',
    type: 'spki',
  });
}

/** A new Ed25519 key pair. @returns {{ privateKey: import('node:crypto').KeyObject, publicKey: string, keyId: string }} */
export function generateKey() {
  const { privateKey } = generateKeyPairSync('ed25519');
  const publicKey = rawPublicKey(privateKey);
  return { privateKey, publicKey, keyId: keyIdOf(publicKey) };
}

/** @param {Uint8Array} pkcs8 @returns {import('node:crypto').KeyObject} */
export function privateKeyFromPkcs8(pkcs8) {
  return createPrivateKey({ key: Buffer.from(pkcs8), format: 'der', type: 'pkcs8' });
}

/**
 * A `.sig` file over exactly `bytes`.
 *
 * @param {Uint8Array} bytes
 * @param {readonly { privateKey: import('node:crypto').KeyObject, keyId: string }[]} keys
 * @returns {string}
 */
export function signatureFile(bytes, keys) {
  return canonicalJson({
    schema: 1,
    signatures: keys.map((k) => ({
      key_id: k.keyId,
      sig: sign(null, bytes, k.privateKey).toString('base64'),
    })),
  });
}

/**
 * The id of the first key of `keys` (id → base64 public key) with a valid signature in `sigText`,
 * or `null`.
 *
 * @param {Uint8Array} bytes
 * @param {string} sigText
 * @param {ReadonlyMap<string, string>} keys
 * @returns {string | null}
 */
export function verifiedBy(bytes, sigText, keys) {
  /** @type {unknown} */
  let parsed;
  try {
    parsed = JSON.parse(sigText);
  } catch {
    return null;
  }
  const sigs = /** @type {{ signatures?: unknown } | null | undefined} */ (parsed)?.signatures;
  if (!Array.isArray(sigs)) return null;
  for (const entry of sigs) {
    const keyId = entry?.key_id;
    const sig = entry?.sig;
    const publicKey = typeof keyId === 'string' ? keys.get(keyId) : undefined;
    if (publicKey === undefined || typeof sig !== 'string') continue;
    try {
      if (verify(null, bytes, publicKeyObject(publicKey), Buffer.from(sig, 'base64'))) return keyId;
    } catch {
      // a malformed key or signature never verifies
    }
  }
  return null;
}

/**
 * @typedef {{ slot: number, key_id: string, public_key: string, test: boolean }} RootKey
 * @typedef {{ placeholder: boolean, test: boolean, keys: RootKey[], problems: string[] }} RootKeys
 */

/**
 * The root public keys in `<dir>/root-1.pub` and `root-2.pub`.
 *
 * @param {string} dir
 * @returns {RootKeys}
 */
export function readRootKeys(dir) {
  /** @type {RootKey[]} */
  const keys = [];
  /** @type {string[]} */
  const problems = [];
  let placeholder = false;
  for (const slot of [1, 2]) {
    const path = join(dir, `root-${slot}.pub`);
    if (!existsSync(path)) {
      problems.push(`root-${slot}.pub is missing`);
      continue;
    }
    /** @type {Record<string, unknown>} */
    let file;
    try {
      file = JSON.parse(readFileSync(path, 'utf8'));
    } catch {
      problems.push(`root-${slot}.pub is not JSON`);
      continue;
    }
    if (file['placeholder'] === true) {
      placeholder = true;
      continue;
    }
    const publicKey = file['public_key'];
    const keyId = file['key_id'];
    if (typeof publicKey !== 'string' || typeof keyId !== 'string' || file['slot'] !== slot) {
      problems.push(`root-${slot}.pub: needs slot ${slot}, key_id and public_key`);
      continue;
    }
    try {
      publicKeyObject(publicKey);
    } catch {
      problems.push(`root-${slot}.pub: not an Ed25519 public key`);
      continue;
    }
    if (keyIdOf(publicKey) !== keyId) {
      problems.push(`root-${slot}.pub: key_id is not the id of public_key`);
      continue;
    }
    keys.push({ slot, key_id: keyId, public_key: publicKey, test: file['test'] === true });
  }
  if (keys.length === 2 && keys[0]?.key_id === keys[1]?.key_id) {
    problems.push('root-1.pub and root-2.pub hold the same key');
  }
  return { placeholder, test: keys.some((k) => k.test), keys, problems };
}

/**
 * Runs `git` in `root` and returns stdout as bytes.
 *
 * @param {string} root
 * @param {string[]} args
 * @returns {Buffer}
 */
function git(root, args) {
  return execFileSync('git', ['-C', root, ...args], {
    maxBuffer: 64 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

/**
 * Refuses a shallow clone in CI: the listed versions come from history, so the build and the
 * signing job both need all of it (`actions/checkout` with `fetch-depth: 0`). Elsewhere (a
 * developer's shallow clone) it only warns: older versions may then be missing from the output.
 *
 * @param {string} root
 */
export function requireFullHistory(root) {
  const shallow = git(root, ['rev-parse', '--is-shallow-repository']).toString('utf8').trim();
  if (shallow !== 'true') return;
  if (process.env['CI'] === 'true') {
    throw new Error('the registry needs the full git history (actions/checkout fetch-depth: 0)');
  }
  console.warn('registry: this clone is shallow; versions older than its history are left out');
}

/**
 * A file at `ref` (`null`: the working tree), or `null` when it does not exist there.
 *
 * @param {string} root
 * @param {string | null} ref
 * @param {string} path relative, POSIX
 * @returns {Buffer | null}
 */
function readAt(root, ref, path) {
  if (ref === null) {
    const full = join(root, path);
    return existsSync(full) ? readFileSync(full) : null;
  }
  try {
    return git(root, ['show', `${ref}:${path}`]);
  } catch {
    return null;
  }
}

/** @param {string} root @param {string | null} ref @param {string} dir @returns {string[]} */
function listAt(root, ref, dir) {
  if (ref === null) {
    const full = join(root, dir);
    return existsSync(full) ? readdirSync(full).sort() : [];
  }
  try {
    return git(root, ['ls-tree', '--name-only', `${ref}:${dir}`])
      .toString('utf8')
      .split('\n')
      .filter((n) => n !== '')
      .sort();
  } catch {
    return [];
  }
}

/** @param {Uint8Array} bytes @returns {Record<string, unknown> | null} */
function objectOf(bytes) {
  try {
    const value = JSON.parse(Buffer.from(bytes).toString('utf8'));
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

/**
 * Every version of `registry/packs/<id>.json` reachable from `ref` (`null`: HEAD), the bytes of
 * the newest commit that held each version.
 *
 * @param {string} root
 * @param {string | null} ref
 * @param {string} id
 * @returns {Map<number, Buffer>}
 */
export function packHistory(root, ref, id) {
  const path = `registry/packs/${id}.json`;
  /** @type {Map<number, Buffer>} */
  const versions = new Map();
  /** @type {string[]} */
  let commits = [];
  try {
    commits = git(root, ['log', '--full-history', '--format=%H', ref ?? 'HEAD', '--', path])
      .toString('utf8')
      .split('\n')
      .filter((c) => c !== '');
  } catch {
    commits = [];
  }
  for (const commit of commits) {
    const bytes = readAt(root, commit, path);
    const version = bytes === null ? undefined : objectOf(bytes)?.['version'];
    if (bytes === null || typeof version !== 'number' || versions.has(version)) continue;
    versions.set(version, bytes);
  }
  return versions;
}

/**
 * @typedef {{ v: number, min_client: string, max_client?: string, sha256: string, size: number,
 *   path: string, released: string, notes: string, revoked?: boolean }} IndexVersion
 * @typedef {{ id: string, title: string, versions: IndexVersion[] }} IndexPack
 * @typedef {{ schema: 1, packs: IndexPack[] }} UnsignedIndex
 * @typedef {{ index: UnsignedIndex, files: Map<string, Buffer>, current: Map<string, Buffer>,
 *   problems: string[] }} CollectedRegistry
 */

/**
 * Assembles the unsigned index of `registry/` at `ref` (`null`: the working tree and HEAD's
 * history): one entry per `registry/packs/<id>.json`; its listed versions are the entries of
 * `registry/versions/<id>.json` (newest ten), each with the bytes of the newest commit that held
 * that version (the current one from the file itself). Validation of the pack content is the
 * build's (`registry-build.ts`, with core); this only reports what it cannot assemble.
 *
 * @param {string} root the repository
 * @param {string | null} [ref]
 * @returns {CollectedRegistry}
 */
export function collectRegistry(root, ref = null) {
  /** @type {string[]} */
  const problems = [];
  /** @type {Map<string, Buffer>} */
  const files = new Map();
  /** @type {Map<string, Buffer>} */
  const current = new Map();
  /** @type {IndexPack[]} */
  const packs = [];
  const ids = listAt(root, ref, 'registry/packs')
    .filter((n) => n.endsWith('.json'))
    .map((n) => n.slice(0, -'.json'.length));
  for (const id of ids) {
    const bytes = readAt(root, ref, `registry/packs/${id}.json`);
    const pack = bytes === null ? null : objectOf(bytes);
    if (bytes === null || pack === null || typeof pack['version'] !== 'number') {
      problems.push(`registry/packs/${id}.json: not a pack`);
      continue;
    }
    current.set(id, bytes);
    const metaBytes = readAt(root, ref, `registry/versions/${id}.json`);
    const meta = metaBytes === null ? null : objectOf(metaBytes);
    const entries = /** @type {Record<string, Record<string, unknown>> | undefined} */ (
      meta?.['versions']
    );
    if (meta === null || entries === undefined || typeof entries !== 'object') {
      problems.push(`registry/versions/${id}.json: missing (list each published version)`);
      continue;
    }
    const history = packHistory(root, ref, id);
    history.set(pack['version'], bytes);
    const listed = Object.keys(entries)
      .map(Number)
      .filter((v) => Number.isInteger(v) && v >= 1)
      .sort((a, b) => b - a);
    if (!listed.includes(pack['version'])) {
      problems.push(
        `registry/versions/${id}.json: no entry for the current version ${pack['version']}`,
      );
    }
    /** @type {IndexVersion[]} */
    const versions = [];
    for (const v of listed.filter((x) => x <= Number(pack['version'])).slice(0, MAX_VERSIONS)) {
      const entry = entries[String(v)] ?? {};
      const versionBytes = history.get(v);
      if (versionBytes === undefined) {
        problems.push(
          `registry/versions/${id}.json: version ${v} is in no commit of registry/packs/${id}.json`,
        );
        continue;
      }
      const body = objectOf(versionBytes) ?? {};
      const sha256 = sha256Hex(versionBytes);
      const path = `packs/${id}/${sha256}.json`;
      const released = entry['released'];
      const notes = entry['notes'];
      if (typeof released !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(released)) {
        problems.push(`registry/versions/${id}.json: version ${v} needs released (YYYY-MM-DD)`);
      }
      if (typeof notes !== 'string' || notes.length > NOTES_MAX) {
        problems.push(
          `registry/versions/${id}.json: version ${v} needs notes (at most ${NOTES_MAX} characters)`,
        );
      }
      versions.push({
        v,
        min_client: String(body['min_client']),
        ...(typeof body['max_client'] === 'string' && { max_client: body['max_client'] }),
        sha256,
        size: versionBytes.byteLength,
        path,
        released: String(released),
        notes: String(notes),
        ...(entry['revoked'] === true && { revoked: true }),
      });
      files.set(path, versionBytes);
    }
    if (versions.length > 0) packs.push({ id, title: String(pack['title']), versions });
  }
  return { index: { schema: 1, packs }, files, current, problems };
}
