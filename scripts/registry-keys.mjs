#!/usr/bin/env node
// @ts-check
/**
 * @module scripts/registry-keys — the owner's offline tool for the site-pack registry keys (spec 13
 * §10.2, §10.7; the key ceremony in docs/contributing/registry.md). Standalone on purpose (D-82):
 * it imports only Node built-ins (`node:crypto`, `node:fs`, `node:path`, `node:os`, `node:url`,
 * `node:readline`), no file of the repository and no package, so decrypting a root key loads no
 * third-party code. Run it with plain `node`, ideally from a fresh checkout on an offline machine
 * with no `bun install`. It never touches the network. Private keys are written only to the paths
 * you name, outside any git working tree, as new files with mode 0600; public files go to
 * `registry/keys/` and the pinned list in `trust-root.ts`.
 *
 *   node scripts/registry-keys.mjs init-roots --out <dir>                 the two root keys (once)
 *   node scripts/registry-keys.mjs online-key --root <root-N.key> --secret-out <file> [--days 90] [--keys-days 120]
 *   node scripts/registry-keys.mjs sign-keys  --root <root-N.key> [--keys-days 120] [--index-floor <n>]
 *   node scripts/registry-keys.mjs revoke     --root <root-N.key> --key-id <id> [--keys-days 120]
 *   node scripts/registry-keys.mjs status
 *   node scripts/registry-keys.mjs dry-run [--out <empty dir>] [--layout <dir from registry-build.ts>]
 *
 * `--passphrase-file <file>` reads the passphrase instead of prompting (tests); `--repo <dir>`
 * works on another checkout.
 */
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
  scryptSync,
  sign,
  verify,
} from 'node:crypto';
import {
  closeSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

const DAY_MS = 86_400_000;
const KEYS_MAX_DAYS = 120;
const ONLINE_MAX_DAYS = 90;
const MAX_ONLINE = 4;
const INDEX_LIFETIME_MS = 14 * DAY_MS;
const MIN_PASSPHRASE = 12;
const SECRET_PREFIX = 'bhreg1';
const KIND = 'browserhive-registry-root-key';
const SCRYPT = { N: 2 ** 17, r: 8, p: 1 };
const SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
const BEGIN = '// BEGIN PINNED ROOT KEYS';
const END = '// END PINNED ROOT KEYS';
const TRUST_ROOT = 'packages/core/src/infra/site-packs/trust-root.ts';

/** @typedef {import('node:crypto').KeyObject} KeyObject */
/** @typedef {{ slot: number, keyId: string, publicKey: string, privateKey: KeyObject, test: boolean }} RootKey */
/** @typedef {{ slot: number, key_id: string, public_key: string, test: boolean }} RootPub */
/** @typedef {{ schema: 1, version: number, expires: string, index_floor?: number, online: { key_id: string, public_key: string, not_after: string }[] }} KeysJson */
/** @typedef {{ pubDir: string, trustRoot: string | null, test: boolean }} KeyPaths */

// ---- canonical JSON, keys, signatures ----------------------------------------------------------

/** @param {unknown} v @returns {unknown} */
function sortKeys(v) {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v !== null && typeof v === 'object') {
    /** @type {Record<string, unknown>} */
    const out = {};
    for (const k of Object.keys(v).sort())
      out[k] = sortKeys(/** @type {Record<string, unknown>} */ (v)[k]);
    return out;
  }
  return v;
}

/** Canonical JSON: sorted keys, two spaces, a final newline. @param {unknown} value */
export function canonicalJson(value) {
  return `${JSON.stringify(sortKeys(value), null, 2)}\n`;
}

/** @param {number} ms */
function instant(ms) {
  return `${new Date(Math.floor(ms / 1000) * 1000).toISOString().slice(0, 19)}Z`;
}

/** @param {string} publicKey base64 raw */
function keyIdOf(publicKey) {
  return createHash('sha256').update(Buffer.from(publicKey, 'base64')).digest('hex').slice(0, 16);
}

/** @param {KeyObject} key */
function rawPublicKey(key) {
  const pub = key.type === 'private' ? createPublicKey(key) : key;
  return Buffer.from(pub.export({ format: 'der', type: 'spki' }))
    .subarray(12)
    .toString('base64');
}

/** @returns {{ privateKey: KeyObject, publicKey: string, keyId: string }} */
function generateKey() {
  const { privateKey } = generateKeyPairSync('ed25519');
  const publicKey = rawPublicKey(privateKey);
  return { privateKey, publicKey, keyId: keyIdOf(publicKey) };
}

/** @param {Uint8Array} bytes @param {{ privateKey: KeyObject, keyId: string }[]} keys */
function signatureFile(bytes, keys) {
  return canonicalJson({
    schema: 1,
    signatures: keys.map((k) => ({
      key_id: k.keyId,
      sig: sign(null, bytes, k.privateKey).toString('base64'),
    })),
  });
}

/** The key id of a valid signature in `sigText` by one of `keys`, else `null`. @param {Uint8Array} bytes @param {string} sigText @param {Map<string, string>} keys */
function verifiedBy(bytes, sigText, keys) {
  let parsed;
  try {
    parsed = JSON.parse(sigText);
  } catch {
    return null;
  }
  for (const entry of Array.isArray(parsed?.signatures) ? parsed.signatures : []) {
    const publicKey = keys.get(entry?.key_id);
    if (publicKey === undefined || typeof entry?.sig !== 'string') continue;
    try {
      const key = createPublicKey({
        key: Buffer.concat([SPKI_PREFIX, Buffer.from(publicKey, 'base64')]),
        format: 'der',
        type: 'spki',
      });
      if (verify(null, bytes, key, Buffer.from(entry.sig, 'base64'))) return String(entry.key_id);
    } catch {
      // a malformed key or signature never verifies
    }
  }
  return null;
}

// ---- files ---------------------------------------------------------------------------------------

/** Writes a new file with mode 0600; refuses an existing one. @param {string} path @param {string} data */
function writeSecretFile(path, data) {
  const fd = openSync(path, 'wx', 0o600);
  try {
    writeSync(fd, data);
  } finally {
    closeSync(fd);
  }
}

/** @param {number} slot @param {string} keyId @param {string} publicKey */
function aad(slot, keyId, publicKey) {
  return Buffer.from(`${KIND}:${slot}:${keyId}:${publicKey}`, 'utf8');
}

/** @param {string} passphrase @param {Buffer} salt @param {{ N: number, r: number, p: number }} k */
function derive(passphrase, salt, k) {
  return scryptSync(passphrase.normalize('NFC'), salt, 32, {
    N: k.N,
    r: k.r,
    p: k.p,
    maxmem: 256 * 1024 * 1024,
  });
}

/** Encrypts `privateKey` under `passphrase` into the new file `path` (0600). @param {string} path @param {number} slot @param {KeyObject} privateKey @param {string} passphrase @param {boolean} test */
export function writeRootKeyFile(path, slot, privateKey, passphrase, test) {
  const publicKey = rawPublicKey(privateKey);
  const keyId = keyIdOf(publicKey);
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', derive(passphrase, salt, SCRYPT), iv);
  cipher.setAAD(aad(slot, keyId, publicKey));
  const ciphertext = Buffer.concat([
    cipher.update(privateKey.export({ format: 'der', type: 'pkcs8' })),
    cipher.final(),
  ]);
  writeSecretFile(
    path,
    canonicalJson({
      schema: 1,
      kind: KIND,
      slot,
      key_id: keyId,
      public_key: publicKey,
      test,
      kdf: { name: 'scrypt', ...SCRYPT, salt: salt.toString('base64') },
      cipher: {
        name: 'aes-256-gcm',
        iv: iv.toString('base64'),
        tag: cipher.getAuthTag().toString('base64'),
      },
      ciphertext: ciphertext.toString('base64'),
    }),
  );
}

/** Decrypts a root key file. @param {string} path @param {string} passphrase @returns {RootKey} */
export function readRootKeyFile(path, passphrase) {
  const f = JSON.parse(readFileSync(path, 'utf8'));
  const ok =
    f?.schema === 1 &&
    f.kind === KIND &&
    (f.slot === 1 || f.slot === 2) &&
    typeof f.key_id === 'string' &&
    typeof f.public_key === 'string' &&
    typeof f.ciphertext === 'string' &&
    f.kdf?.name === 'scrypt' &&
    Number.isInteger(f.kdf.N) &&
    f.cipher?.name === 'aes-256-gcm';
  if (!ok) throw new Error(`${path} is not a registry root key file`);
  const decipher = createDecipheriv(
    'aes-256-gcm',
    derive(passphrase, Buffer.from(f.kdf.salt, 'base64'), f.kdf),
    Buffer.from(f.cipher.iv, 'base64'),
  );
  decipher.setAAD(aad(f.slot, f.key_id, f.public_key));
  decipher.setAuthTag(Buffer.from(f.cipher.tag, 'base64'));
  let pkcs8;
  try {
    pkcs8 = Buffer.concat([decipher.update(Buffer.from(f.ciphertext, 'base64')), decipher.final()]);
  } catch {
    throw new Error(`${path}: wrong passphrase, or the file was changed`);
  }
  const privateKey = createPrivateKey({ key: pkcs8, format: 'der', type: 'pkcs8' });
  const publicKey = rawPublicKey(privateKey);
  if (publicKey !== f.public_key || keyIdOf(publicKey) !== f.key_id)
    throw new Error(`${path}: the key does not match its public key`);
  return { slot: f.slot, keyId: f.key_id, publicKey, privateKey, test: f.test === true };
}

/** The root public keys in `dir` (placeholders give none). @param {string} dir */
export function readRootPubs(dir) {
  /** @type {RootPub[]} */
  const keys = [];
  /** @type {string[]} */
  const problems = [];
  let placeholder = false;
  for (const slot of [1, 2]) {
    const path = join(dir, `root-${slot}.pub`);
    if (!existsSync(path)) continue;
    let f;
    try {
      f = JSON.parse(readFileSync(path, 'utf8'));
    } catch {
      problems.push(`root-${slot}.pub is not JSON`);
      continue;
    }
    if (f.placeholder === true) placeholder = true;
    else if (
      f.slot !== slot ||
      typeof f.public_key !== 'string' ||
      keyIdOf(f.public_key) !== f.key_id
    )
      problems.push(`root-${slot}.pub is malformed`);
    else keys.push({ slot, key_id: f.key_id, public_key: f.public_key, test: f.test === true });
  }
  return { keys, problems, placeholder, test: keys.some((k) => k.test) };
}

/** The keys pinned in a `trust-root.ts` (read as text). @param {string} path */
export function pinnedIn(path) {
  const text = readFileSync(path, 'utf8');
  const block = text.slice(text.indexOf(BEGIN), text.indexOf(END));
  return [
    ...block.matchAll(/\{ keyId: '([0-9a-f]{16})', publicKey: '([A-Za-z0-9+/=]{44})' \}/g),
  ].map((m) => ({ keyId: m[1] ?? '', publicKey: m[2] ?? '' }));
}

/** Refuses a private-key path inside a git working tree. @param {string} path @param {boolean} [isDir] */
export function outsideGit(path, isDir = false) {
  const full = resolve(path);
  for (let at = isDir ? full : dirname(full); ; at = dirname(at)) {
    if (existsSync(join(at, '.git')))
      throw new Error(
        `${full} is inside a git working tree; keep private keys elsewhere (an offline drive)`,
      );
    if (dirname(at) === at) return full;
  }
}

// ---- operations ----------------------------------------------------------------------------------

/** @param {number} ms */
const day = (ms) => new Date(ms).toISOString().slice(0, 10);

/** Both roots set, test keys exactly in a dry run. @param {KeyPaths} paths */
function loadRoots(paths) {
  const roots = readRootPubs(paths.pubDir);
  if (roots.placeholder) throw new Error('the root keys are placeholders: run init-roots first');
  if (roots.problems.length > 0) throw new Error(roots.problems.join('; '));
  if (roots.keys.length !== 2) throw new Error('root-1.pub and root-2.pub are both needed');
  if (roots.test !== paths.test)
    throw new Error(
      paths.test ? 'a dry run needs throwaway roots' : 'registry/keys holds test root keys',
    );
  return new Map(roots.keys.map((k) => [k.key_id, k.public_key]));
}

/** Creates both root keys, writes their `.pub` files and the pinned list. @param {KeyPaths} paths @param {string} outDir @param {[string, string]} passphrases @param {number} now @param {boolean} replace */
export function initRoots(paths, outDir, passphrases, now, replace) {
  const current = readRootPubs(paths.pubDir);
  if (current.keys.length > 0 && !replace)
    throw new Error('root keys are already set; replacing them needs a release (pass --replace)');
  const made = [1, 2].map((slot) => {
    const key = generateKey();
    const file = join(outDir, `root-${slot}.key`);
    writeRootKeyFile(file, slot, key.privateKey, passphrases[slot - 1] ?? '', paths.test);
    return { slot, keyId: key.keyId, publicKey: key.publicKey, file };
  });
  for (const k of made) {
    writeFileSync(
      join(paths.pubDir, `root-${k.slot}.pub`),
      canonicalJson({
        schema: 1,
        role: 'root',
        slot: k.slot,
        key_id: k.keyId,
        public_key: k.publicKey,
        created: day(now),
        ...(paths.test && { test: true, note: 'A throwaway dry-run root. Nothing trusts it.' }),
      }),
    );
  }
  if (paths.trustRoot !== null) {
    const text = readFileSync(paths.trustRoot, 'utf8');
    const start = text.indexOf(BEGIN);
    const end = text.indexOf(END);
    if (start < 0 || end < start)
      throw new Error(`${paths.trustRoot}: the pinned-keys markers are missing`);
    const block = [
      BEGIN,
      '/** The pinned root keys. */',
      'export const PINNED_ROOT_KEYS: readonly TrustRootKey[] = [',
      ...made.flatMap((k) => [
        `  // root-${k.slot}.pub, created ${day(now)}`,
        `  { keyId: '${k.keyId}', publicKey: '${k.publicKey}' },`,
      ]),
      '];',
    ].join('\n');
    writeFileSync(paths.trustRoot, `${text.slice(0, start)}${block}\n${text.slice(end)}`);
  }
  return made.map(({ slot, keyId, file }) => ({ slot, keyId, file }));
}

/** The current `keys.json`, checked against the roots; `null` when there is none. @param {KeyPaths} paths @param {Map<string, string>} roots @returns {KeysJson | null} */
export function readKeys(paths, roots) {
  const file = join(paths.pubDir, 'keys.json');
  if (!existsSync(file)) return null;
  const bytes = readFileSync(file);
  const sig = existsSync(`${file}.sig`) ? readFileSync(`${file}.sig`, 'utf8') : '';
  if (verifiedBy(bytes, sig, roots) === null)
    throw new Error(`${file}: no root signature verifies; restore it from git before going on`);
  const keys = JSON.parse(bytes.toString('utf8'));
  if (keys?.schema !== 1 || !Number.isSafeInteger(keys.version) || !Array.isArray(keys.online))
    throw new Error(`${file} is not a keys file`);
  return keys;
}

/** @param {RootKey} root @param {Map<string, string>} roots */
function requireRoot(root, roots) {
  if (roots.get(root.keyId) !== root.publicKey)
    throw new Error(`root key ${root.keyId} is not root-1.pub or root-2.pub`);
}

/** @param {KeyPaths} paths @param {RootKey} root @param {KeysJson} keys */
function writeKeys(paths, root, keys) {
  const bytes = Buffer.from(canonicalJson(keys));
  writeFileSync(join(paths.pubDir, 'keys.json'), bytes);
  writeFileSync(join(paths.pubDir, 'keys.json.sig'), signatureFile(bytes, [root]));
}

/** @param {KeysJson | null} previous @param {KeysJson['online']} online @param {{ now: number, keysDays: number, indexFloor?: number }} change @returns {KeysJson} */
function nextKeys(previous, online, change) {
  if (!(change.keysDays >= 1 && change.keysDays <= KEYS_MAX_DAYS))
    throw new Error(`keys.json may expire at most ${KEYS_MAX_DAYS} days ahead`);
  if (online.length === 0) throw new Error('keys.json needs at least one online key');
  if (online.length > MAX_ONLINE)
    throw new Error(`at most ${MAX_ONLINE} online keys; revoke one first`);
  return {
    schema: 1,
    version: (previous?.version ?? 0) + 1,
    expires: instant(change.now + change.keysDays * DAY_MS),
    // Transient: a client honours it once, for this keys.json version (spec 13 §10.3).
    ...(change.indexFloor !== undefined && { index_floor: change.indexFloor }),
    online,
  };
}

/** Adds an online key valid `days` and re-signs `keys.json`; the secret value goes to the new file `secretOut` only. @param {KeyPaths} paths @param {RootKey} root @param {string} secretOut @param {number} days @param {{ now: number, keysDays: number }} change */
export function addOnlineKey(paths, root, secretOut, days, change) {
  if (!(days >= 1 && days <= ONLINE_MAX_DAYS))
    throw new Error(`an online key is valid at most ${ONLINE_MAX_DAYS} days`);
  const roots = loadRoots(paths);
  requireRoot(root, roots);
  const previous = readKeys(paths, roots);
  const key = generateKey();
  const notAfter = instant(change.now + days * DAY_MS);
  const kept = (previous?.online ?? []).filter((k) => Date.parse(k.not_after) > change.now);
  const keys = nextKeys(
    previous,
    [...kept, { key_id: key.keyId, public_key: key.publicKey, not_after: notAfter }],
    change,
  );
  const pkcs8 = key.privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64');
  writeSecretFile(secretOut, `${SECRET_PREFIX}.${key.keyId}.${pkcs8}\n`);
  writeKeys(paths, root, keys);
  return { keyId: key.keyId, notAfter, keys };
}

/** Re-signs `keys.json` with a new version and expiry, optionally without online key `revoke`. @param {KeyPaths} paths @param {RootKey} root @param {{ now: number, keysDays: number, indexFloor?: number, revoke?: string }} change */
export function resignKeys(paths, root, change) {
  const roots = loadRoots(paths);
  requireRoot(root, roots);
  const previous = readKeys(paths, roots);
  if (previous === null) throw new Error('there is no keys.json yet: run online-key first');
  if (change.revoke !== undefined && !previous.online.some((k) => k.key_id === change.revoke))
    throw new Error(`keys.json lists no online key ${change.revoke}`);
  const online = previous.online.filter(
    (k) => k.key_id !== change.revoke && Date.parse(k.not_after) > change.now,
  );
  const keys = nextKeys(previous, online, change);
  writeKeys(paths, root, keys);
  return keys;
}

// ---- dry run -------------------------------------------------------------------------------------

const DRY_PASSPHRASE = 'dry-run throwaway passphrase';

/** The whole ceremony with throwaway keys in `dir` (nothing in the repository changes); `trustRoot` is a scratch copy it rewrites, `pinnedFrom` the repository's own. @param {{ dir: string, trustRoot: string, pinnedFrom: string, now: number, layout: string | null }} input */
export function dryRun(input) {
  const pub = join(input.dir, 'registry-keys');
  const offline = join(input.dir, 'offline');
  mkdirSync(pub, { recursive: true });
  mkdirSync(offline, { recursive: true, mode: 0o700 });
  /** @type {KeyPaths} */
  const paths = { pubDir: pub, trustRoot: input.trustRoot, test: true };
  const step = (/** @type {number} */ n, /** @type {string} */ text) =>
    console.log(`\nStep ${n}. ${text}`);
  console.log(
    `Dry run in ${input.dir}: throwaway keys, passphrase "${DRY_PASSPHRASE}". Nothing in the repository changes.`,
  );
  step(
    1,
    'init-roots: two root keys, each encrypted under its passphrase; their public halves become root-1.pub, root-2.pub and the pinned list in trust-root.ts.',
  );
  for (const k of initRoots(paths, offline, [DRY_PASSPHRASE, DRY_PASSPHRASE], input.now, false))
    console.log(`  root ${k.slot}: ${k.keyId} -> ${k.file}`);
  const root1 = readRootKeyFile(join(offline, 'root-1.key'), DRY_PASSPHRASE);
  const root2 = readRootKeyFile(join(offline, 'root-2.key'), DRY_PASSPHRASE);
  step(
    2,
    'online-key (root 1): a CI key valid 90 days; keys.json version 1, signed by root 1; the secret value written for the environment secret.',
  );
  const first = addOnlineKey(paths, root1, join(offline, 'online-1.secret'), 90, {
    now: input.now,
    keysDays: 120,
  });
  console.log(`  online key ${first.keyId} until ${first.notAfter}`);
  step(
    3,
    'sign-keys (root 2): either root can re-sign keys.json (threshold 1 of 2), e.g. to extend its expiry.',
  );
  console.log(
    `  keys.json version ${resignKeys(paths, root2, { now: input.now, keysDays: 120 }).version}`,
  );
  step(
    4,
    'Rotation, every 90 days at the latest: online-key adds the next key, then revoke drops the old one.',
  );
  const second = addOnlineKey(paths, root1, join(offline, 'online-2.secret'), 90, {
    now: input.now,
    keysDays: 120,
  });
  const revoked = resignKeys(paths, root2, { now: input.now, keysDays: 120, revoke: first.keyId });
  console.log(
    `  added ${second.keyId}, revoked ${first.keyId}; keys.json version ${revoked.version}`,
  );
  step(
    5,
    'Checks: keys.json verifies under the throwaway roots, and the real trust-root.ts pins none of them.',
  );
  const roots = loadRoots(paths);
  const keysBytes = readFileSync(join(pub, 'keys.json'));
  const keysSig = readFileSync(join(pub, 'keys.json.sig'), 'utf8');
  const accepted = verifiedBy(keysBytes, keysSig, roots) !== null;
  console.log(`  throwaway root: ${accepted ? 'accepted' : 'REFUSED (unexpected)'}`);
  const pinned = new Set(pinnedIn(input.pinnedFrom).map((k) => k.keyId));
  console.log(
    `  pinned root: ${[...roots.keys()].some((id) => pinned.has(id)) ? 'PINS A THROWAWAY KEY (unexpected)' : 'pins none of them'}`,
  );
  let signed = null;
  if (input.layout !== null) {
    step(6, 'A signed index over the build in --layout, as the CI signing job writes it.');
    signed = join(input.dir, 'layout');
    const unsigned = JSON.parse(readFileSync(join(input.layout, 'index.json'), 'utf8'));
    const index = Buffer.from(
      canonicalJson({
        schema: 1,
        version: 1,
        issued_at: instant(input.now),
        expires: instant(input.now + INDEX_LIFETIME_MS),
        packs: unsigned.packs,
      }),
    );
    const [, keyId, b64] = readFileSync(join(offline, 'online-2.secret'), 'utf8').trim().split('.');
    const online = {
      keyId: keyId ?? '',
      privateKey: createPrivateKey({
        key: Buffer.from(b64 ?? '', 'base64'),
        format: 'der',
        type: 'pkcs8',
      }),
    };
    mkdirSync(join(signed, 'packs'), { recursive: true });
    writeFileSync(join(signed, 'index.json'), index);
    writeFileSync(join(signed, 'index.json.sig'), signatureFile(index, [online]));
    writeFileSync(join(signed, 'keys.json'), keysBytes);
    writeFileSync(join(signed, 'keys.json.sig'), keysSig);
    for (const pack of unsigned.packs)
      for (const v of pack.versions) {
        mkdirSync(join(signed, 'packs', pack.id), { recursive: true });
        copyFileSync(join(input.layout, v.path), join(signed, v.path));
      }
    console.log(
      `  written to ${signed}. Check it with BrowserHive's own verifier, in another process (it never sees a private key):`,
    );
    console.log(
      `  bun scripts/registry-verify.ts ${signed} --test-root ${join(pub, 'root-1.pub')} --test-root ${join(pub, 'root-2.pub')} --expect-pinned-refusal`,
    );
  }
  console.log(`\nDone. Delete ${input.dir} when you have read it.`);
  return { pubDir: pub, offline, accepted, signed };
}

// ---- command line --------------------------------------------------------------------------------

/** @param {string} prompt @returns {Promise<string>} */
function hidden(prompt) {
  const stdin = process.stdin;
  process.stdout.write(prompt);
  stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding('utf8');
  return new Promise((done, fail) => {
    let value = '';
    const stop = () => {
      stdin.off('data', onData);
      stdin.setRawMode(false);
      stdin.pause();
      process.stdout.write('\n');
    };
    const onData = (/** @type {string} */ chunk) => {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n') {
          stop();
          done(value);
          return;
        }
        if (ch === '\u0003' || ch === '\u0004') {
          stop();
          fail(new Error('cancelled'));
          return;
        }
        value = ch === '\u007f' || ch === '\b' ? value.slice(0, -1) : value + ch;
      }
    };
    stdin.on('data', onData);
  });
}

/** @param {string | null} file */
function prompter(file) {
  if (file !== null) {
    const value = readFileSync(file, 'utf8').split('\n')[0] ?? '';
    if (value.length < MIN_PASSPHRASE)
      throw new Error(`the passphrase must be at least ${MIN_PASSPHRASE} characters`);
    return { passphrase: async () => value, yes: async () => true };
  }
  if (!process.stdin.isTTY)
    throw new Error('passphrases are typed on a terminal (or given with --passphrase-file)');
  return {
    /** @param {string} label @param {boolean} confirm */
    async passphrase(label, confirm) {
      for (;;) {
        const first = await hidden(`${label}: `);
        if (first.length < MIN_PASSPHRASE)
          console.log(`  at least ${MIN_PASSPHRASE} characters, please`);
        else if (!confirm || (await hidden(`${label} (again): `)) === first) return first;
        else console.log('  the two did not match; again');
      }
    },
    /** @param {string} question */
    async yes(question) {
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      const answer = await new Promise((done) =>
        rl.question(`${question} Type yes to go on: `, done),
      );
      rl.close();
      return answer === 'yes';
    },
  };
}

/** @param {string[]} argv */
export async function main(argv) {
  const command = argv[0];
  const flag = (/** @type {string} */ name) => {
    const i = argv.indexOf(`--${name}`);
    if (i < 0) return null;
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) throw new Error(`--${name} needs a value`);
    return value;
  };
  const need = (/** @type {string} */ name) =>
    flag(name) ??
    (() => {
      throw new Error(`--${name} <value> is required`);
    })();
  const num = (/** @type {string} */ name, /** @type {number} */ fallback) => {
    const v = flag(name);
    if (v === null) return fallback;
    if (!/^\d+$/.test(v)) throw new Error(`--${name} must be a whole number`);
    return Number(v);
  };
  const here = dirname(fileURLToPath(import.meta.url));
  const repo = resolve(flag('repo') ?? join(here, '..'));
  /** @type {KeyPaths} */
  const paths = {
    pubDir: join(repo, 'registry', 'keys'),
    trustRoot: join(repo, ...TRUST_ROOT.split('/')),
    test: false,
  };
  const now = Date.now();
  const printKeys = (/** @type {KeysJson} */ keys) => {
    const left = (/** @type {string} */ iso) =>
      `${Math.floor((Date.parse(iso) - now) / DAY_MS)} days left`;
    console.log(
      `keys.json version ${keys.version}, expires ${keys.expires} (${left(keys.expires)})`,
    );
    for (const k of keys.online)
      console.log(`  online key ${k.key_id} valid until ${k.not_after} (${left(k.not_after)})`);
  };
  const nextPr =
    'Next: commit registry/keys/keys.json and keys.json.sig in a pull request and merge it; the next signing run uses them.';
  const unlock = async () => {
    const file = need('root');
    const root = readRootKeyFile(
      file,
      await prompter(flag('passphrase-file')).passphrase(`Passphrase of ${file}`, false),
    );
    if (root.test) throw new Error(`${file} is a throwaway dry-run key`);
    console.log(`Unlocked root key ${root.slot} (${root.keyId}).`);
    return root;
  };
  switch (command) {
    case 'init-roots': {
      const out = outsideGit(need('out'), true);
      mkdirSync(out, { recursive: true, mode: 0o700 });
      if (readdirSync(out).some((n) => /^root-[12]\.key$/.test(n)))
        throw new Error(`${out} already holds root keys`);
      const ask = prompter(flag('passphrase-file'));
      const replace = argv.includes('--replace');
      if (
        replace &&
        !(await ask.yes(
          'Replacing the roots needs a release; installs keep trusting the old ones until they upgrade.',
        ))
      )
        return;
      console.log(
        'Each root key is encrypted with its own passphrase. Write both down and keep them apart from the key files.',
      );
      const p1 = await ask.passphrase('Passphrase for root key 1', true);
      const p2 = await ask.passphrase('Passphrase for root key 2', true);
      for (const k of initRoots(paths, out, [p1, p2], now, replace)) {
        readRootKeyFile(k.file, k.slot === 1 ? p1 : p2);
        console.log(
          `Root key ${k.slot}: ${k.keyId} -> ${k.file} (encrypted; read back and checked)`,
        );
      }
      console.log(
        'Wrote registry/keys/root-1.pub, root-2.pub and the pinned list in trust-root.ts.',
      );
      console.log(
        'Next: copy the two .key files to two offline drives kept apart; commit the .pub files and trust-root.ts in a pull request; then run online-key.',
      );
      return;
    }
    case 'online-key': {
      const secretOut = outsideGit(need('secret-out'));
      const made = addOnlineKey(paths, await unlock(), secretOut, num('days', 90), {
        now,
        keysDays: num('keys-days', 120),
      });
      console.log(`New online key ${made.keyId}, valid until ${made.notAfter}.`);
      printKeys(made.keys);
      console.log(
        `The secret value is in ${secretOut} (mode 0600). Put it into the environment secret, then delete the file:`,
      );
      console.log(
        `  gh secret set REGISTRY_ONLINE_KEY --env registry-signing < '${secretOut}' && shred -u '${secretOut}'`,
      );
      console.log(nextPr);
      return;
    }
    case 'sign-keys':
    case 'revoke': {
      const root = await unlock();
      const floor = flag('index-floor');
      const keys = resignKeys(paths, root, {
        now,
        keysDays: num('keys-days', 120),
        ...(floor !== null && { indexFloor: num('index-floor', 0) }),
        ...(command === 'revoke' && { revoke: need('key-id') }),
      });
      printKeys(keys);
      if (command === 'revoke')
        console.log(
          'Also replace REGISTRY_ONLINE_KEY if it held the revoked key (online-key adds a new one).',
        );
      console.log(nextPr);
      return;
    }
    case 'status': {
      const roots = readRootPubs(paths.pubDir);
      if (roots.placeholder)
        console.log('Root keys: placeholders (run init-roots in the key ceremony).');
      for (const k of roots.keys)
        console.log(`Root key ${k.slot}: ${k.key_id}${k.test ? ' (TEST)' : ''}`);
      for (const p of roots.problems) console.log(`Problem: ${p}`);
      const pinned = pinnedIn(paths.trustRoot ?? '');
      console.log(
        `Pinned in trust-root.ts: ${
          pinned
            .map((k) => k.keyId)
            .sort()
            .join(', ') || 'none'
        }`,
      );
      const same =
        pinned
          .map((k) => k.keyId)
          .sort()
          .join() ===
        roots.keys
          .map((k) => k.key_id)
          .sort()
          .join();
      console.log(
        same
          ? 'trust-root.ts pins exactly registry/keys.'
          : 'Problem: trust-root.ts does not pin registry/keys.',
      );
      if (roots.keys.length === 2) {
        const keys = readKeys(paths, loadRoots(paths));
        if (keys === null) console.log('keys.json: none yet (run online-key).');
        else {
          printKeys(keys);
          console.log('keys.json verifies under the root keys.');
        }
      }
      return;
    }
    case 'dry-run': {
      const given = flag('out');
      const dir =
        given === null
          ? mkdtempSync(join(tmpdir(), 'bh-registry-dry-run-'))
          : outsideGit(given, true);
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      if (readdirSync(dir).length > 0) throw new Error(`${dir} is not empty`);
      const trustRoot = join(dir, 'trust-root.ts');
      copyFileSync(paths.trustRoot ?? '', trustRoot);
      const layout = flag('layout');
      dryRun({
        dir,
        trustRoot,
        pinnedFrom: paths.trustRoot ?? '',
        now,
        layout: layout === null ? null : resolve(layout),
      });
      return;
    }
    default: {
      const text = readFileSync(fileURLToPath(import.meta.url), 'utf8');
      console.log(
        text.slice(text.indexOf('@module') + 8, text.indexOf('*/')).replace(/^ \* ?/gm, ''),
      );
      if (command !== undefined) process.exitCode = 64;
    }
  }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(`registry-keys: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}
