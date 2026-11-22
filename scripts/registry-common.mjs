// @ts-check
/**
 * @module scripts/registry-common — the site-pack registry's shared, dependency-free producer code
 * (spec 13 §10.1, §10.2, §10.7): canonical JSON, Ed25519 with `node:crypto`, the root public keys
 * in `registry/keys/`, `registry/state.json`, and the deterministic assembly of the unsigned index
 * from `registry/` and its archive of published versions (no git history, D-81).
 * `registry-build.ts` (with dependencies) and `registry-sign.mjs` (without) both call
 * `collectRegistry`, so the signing job recomputes from the commit exactly what the build produced
 * and can diff the two. Imports only `node:crypto`, `node:fs` and `node:path`.
 */
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign,
  verify,
} from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
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
 * @typedef {{ read(path: string): Buffer | null, list(dir: string): string[] }} TreeReader
 *   Reads repository files by POSIX path relative to the root: the working tree
 *   ({@link fsReader}), or a commit (`registry/check.ts` reads the base through `git`).
 */

/** The working tree at `root`. @param {string} root @returns {TreeReader} */
export function fsReader(root) {
  return {
    read(path) {
      const full = join(root, ...path.split('/'));
      return existsSync(full) && statSync(full).isFile() ? readFileSync(full) : null;
    },
    list(dir) {
      const full = join(root, ...dir.split('/'));
      return existsSync(full) && statSync(full).isDirectory() ? readdirSync(full).sort() : [];
    },
  };
}

/** @param {Uint8Array} bytes @returns {Record<string, unknown> | null} */
export function objectOf(bytes) {
  try {
    const value = JSON.parse(Buffer.from(bytes).toString('utf8'));
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

/** A registrable domain as the index schema accepts it (`PackRegistrableDomain`). */
export const PACK_ID_RE =
  /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,61}[a-z0-9]$/;
/** The highest pack version the index schema accepts. */
export const MAX_PACK_VERSION = 1_000_000;
/** Listed packs at most. */
export const MAX_PACKS = 500;
/** The fast-forward bound of the client (spec 13 §10.3). */
export const INDEX_FAST_FORWARD = 100_000;

/**
 * `registry/state.json`: the last index version the owner recorded as published (a floor the
 * signing job never goes below, D-81). `null` when the file is missing or malformed.
 *
 * @param {TreeReader} reader
 * @returns {{ index_version: number } | null}
 */
export function readState(reader) {
  const bytes = reader.read('registry/state.json');
  const state = bytes === null ? null : objectOf(bytes);
  const version = state?.['index_version'];
  return typeof version === 'number' && Number.isSafeInteger(version) && version >= 0
    ? { index_version: version }
    : null;
}

/**
 * @typedef {{ v: number, min_client: string, max_client?: string, sha256: string, size: number,
 *   path: string, released: string, notes: string, revoked?: boolean }} IndexVersion
 * @typedef {{ id: string, title: string, versions: IndexVersion[] }} IndexPack
 * @typedef {{ schema: 1, packs: IndexPack[] }} UnsignedIndex
 * @typedef {{ index: UnsignedIndex, files: Map<string, Buffer>, current: Map<string, Buffer>,
 *   listed: Map<string, Map<number, string>>, problems: string[] }} CollectedRegistry
 */

/**
 * Assembles the unsigned index of `registry/` (spec 13 §10.1, D-81): one entry per
 * `registry/packs/<id>.json`; its listed versions are the entries of `registry/versions/<id>.json`
 * (the newest ten), each the exact bytes of `registry/archive/<id>/<sha256>.json`, so nothing
 * depends on git history. The current file must equal its version's archived copy. Validation of
 * the pack content is the build's (`registry-build.ts`, with core); this checks what the index
 * schema bounds and what it cannot assemble, so the dependency-free signing job enforces it too.
 *
 * @param {TreeReader} reader
 * @returns {CollectedRegistry}
 */
export function collectRegistry(reader) {
  /** @type {string[]} */
  const problems = [];
  /** @type {Map<string, Buffer>} */
  const files = new Map();
  /** @type {Map<string, Buffer>} */
  const current = new Map();
  /** @type {Map<string, Map<number, string>>} */
  const listed = new Map();
  /** @type {IndexPack[]} */
  const packs = [];
  const ids = reader
    .list('registry/packs')
    .filter((n) => n.endsWith('.json'))
    .map((n) => n.slice(0, -'.json'.length));
  if (ids.length > MAX_PACKS) problems.push(`more than ${MAX_PACKS} packs`);
  for (const dir of reader.list('registry/archive')) {
    if (!ids.includes(dir)) problems.push(`registry/archive/${dir}: no registry/packs/${dir}.json`);
  }
  for (const id of ids) {
    const bytes = reader.read(`registry/packs/${id}.json`);
    const pack = bytes === null ? null : objectOf(bytes);
    const version = pack?.['version'];
    if (!PACK_ID_RE.test(id) || id.length > 253) {
      problems.push(`registry/packs/${id}.json: not a registrable domain`);
      continue;
    }
    if (bytes === null || pack === null || typeof version !== 'number') {
      problems.push(`registry/packs/${id}.json: not a pack`);
      continue;
    }
    current.set(id, bytes);
    const metaBytes = reader.read(`registry/versions/${id}.json`);
    const entries = /** @type {Record<string, Record<string, unknown>> | undefined} */ (
      (metaBytes === null ? null : objectOf(metaBytes))?.['versions']
    );
    if (entries === undefined || entries === null || typeof entries !== 'object') {
      problems.push(`registry/versions/${id}.json: missing (list each published version)`);
      continue;
    }
    /** @type {Map<number, string>} */
    const shas = new Map();
    listed.set(id, shas);
    const all = Object.keys(entries)
      .map(Number)
      .filter((v) => Number.isInteger(v))
      .sort((a, b) => b - a);
    if (!all.includes(version)) {
      problems.push(
        `registry/versions/${id}.json: no entry for the current version ${version} (bun scripts/registry-build.ts --sync)`,
      );
    }
    /** @type {IndexVersion[]} */
    const versions = [];
    for (const v of all) {
      const entry = entries[String(v)] ?? {};
      const where = `registry/versions/${id}.json version ${v}`;
      const sha256 = entry['sha256'];
      if (v < 1 || v > MAX_PACK_VERSION) {
        problems.push(`${where}: versions run from 1 to ${MAX_PACK_VERSION}`);
        continue;
      }
      if (v > version) {
        problems.push(`${where}: above the current version ${version}`);
        continue;
      }
      if (typeof sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(sha256)) {
        problems.push(
          `${where}: needs the sha256 of its archived file (bun scripts/registry-build.ts --sync)`,
        );
        continue;
      }
      shas.set(v, sha256);
      const archived = reader.read(`registry/archive/${id}/${sha256}.json`);
      if (archived === null) {
        problems.push(`${where}: registry/archive/${id}/${sha256}.json is missing`);
        continue;
      }
      const body = objectOf(archived) ?? {};
      if (sha256Hex(archived) !== sha256)
        problems.push(`registry/archive/${id}/${sha256}.json: its SHA-256 is not its name`);
      if (body['id'] !== id || body['version'] !== v)
        problems.push(`registry/archive/${id}/${sha256}.json: is not ${id} v${v}`);
      if (archived.byteLength > PACK_MAX_BYTES)
        problems.push(`registry/archive/${id}/${sha256}.json: larger than ${PACK_MAX_BYTES} bytes`);
      if (v === version && !archived.equals(bytes)) {
        problems.push(
          `registry/packs/${id}.json differs from its archived copy of v${v} (bun scripts/registry-build.ts --sync)`,
        );
      }
      const released = entry['released'];
      const notes = entry['notes'];
      if (typeof released !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(released)) {
        problems.push(`${where}: needs released (YYYY-MM-DD)`);
      }
      if (typeof notes !== 'string' || notes.length < 1 || notes.length > NOTES_MAX) {
        problems.push(`${where}: needs notes (1 to ${NOTES_MAX} characters)`);
      }
      if (versions.length >= MAX_VERSIONS) continue;
      const path = `packs/${id}/${sha256}.json`;
      versions.push({
        v,
        min_client: String(body['min_client']),
        ...(typeof body['max_client'] === 'string' && { max_client: body['max_client'] }),
        sha256,
        size: archived.byteLength,
        path,
        released: String(released),
        notes: String(notes),
        ...(entry['revoked'] === true && { revoked: true }),
      });
      files.set(path, archived);
    }
    const referenced = new Set([...shas.values()].map((sha) => `${sha}.json`));
    for (const name of reader.list(`registry/archive/${id}`)) {
      if (!referenced.has(name))
        problems.push(`registry/archive/${id}/${name}: listed in no registry/versions entry`);
    }
    const title = pack['title'];
    if (typeof title !== 'string' || title.length < 1 || title.length > 60)
      problems.push(`registry/packs/${id}.json: title`);
    if (versions.length > 0) packs.push({ id, title: String(title), versions });
  }
  return { index: { schema: 1, packs }, files, current, listed, problems };
}
