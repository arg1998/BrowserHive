/** @module scripts/registry/keys-ops — the owner's root operations on the registry keys (spec 13 §10.2, §10.7), run offline by `registry-keys.ts`: create the two root keys, add, rotate and revoke the online key, and write and root-sign `keys.json`. Public outputs go to `registry/keys/` (and the pinned list in `trust-root.ts`); private keys only to the paths the owner names. No network. */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import {
  canonicalJson,
  DAY_MS,
  generateKey,
  instant,
  KEYS_MAX_DAYS,
  ONLINE_KEY_MAX_DAYS,
  type RootKeys,
  readRootKeys,
  SECRET_PREFIX,
  signatureFile,
  verifiedBy,
} from '../registry-common.mjs';
import { type RootKey, writeRootKeyFile, writeSecretFile } from './keyfile.ts';

/** Where an operation reads and writes the public files. */
export interface KeyPaths {
  /** `root-1.pub`, `root-2.pub`, `keys.json`, `keys.json.sig` (`registry/keys`). */
  readonly pubDir: string;
  /** The `trust-root.ts` whose pinned list `initRoots` rewrites; `null` leaves it alone. */
  readonly trustRoot: string | null;
  /** Throwaway keys (`dry-run`): every `.pub` is marked `test`. */
  readonly test: boolean;
}

const KeysJson = z.strictObject({
  schema: z.literal(1),
  version: z.number().int().min(1),
  expires: z.string(),
  index_floor: z.number().int().min(0).optional(),
  online: z.array(
    z.strictObject({ key_id: z.string(), public_key: z.string(), not_after: z.string() }),
  ),
});
type KeysJson = z.infer<typeof KeysJson>;

const BEGIN = '// BEGIN PINNED ROOT KEYS';
const END = '// END PINNED ROOT KEYS';
const MAX_ONLINE = 4;

/** `YYYY-MM-DD`. */
function day(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** The roots in `paths.pubDir`, which must both be set (and test keys exactly in a dry run). */
export function loadRoots(paths: KeyPaths): RootKeys {
  const roots = readRootKeys(paths.pubDir);
  if (roots.placeholder) throw new Error('the root keys are placeholders: run init-roots first');
  if (roots.problems.length > 0) throw new Error(roots.problems.join('; '));
  if (roots.keys.length !== 2) throw new Error('root-1.pub and root-2.pub are both needed');
  if (roots.test !== paths.test) {
    throw new Error(
      paths.test ? 'a dry run needs throwaway roots' : 'registry/keys holds test root keys',
    );
  }
  return roots;
}

/**
 * Creates both root keys: each encrypted under its passphrase into `<outDir>/root-<slot>.key`, its
 * public half into `root-<slot>.pub`, and both pinned in `trust-root.ts`.
 */
export function initRoots(
  paths: KeyPaths,
  outDir: string,
  passphrases: readonly [string, string],
  now: number,
  replace: boolean,
): { readonly slot: number; readonly keyId: string; readonly file: string }[] {
  const current = readRootKeys(paths.pubDir);
  if (!current.placeholder && current.keys.length > 0 && !replace) {
    throw new Error('root keys are already set; replacing them needs a release (pass --replace)');
  }
  const made = [1, 2].map((slot) => {
    const key = generateKey();
    const file = join(outDir, `root-${slot}.key`);
    writeRootKeyFile(file, slot, key.privateKey, passphrases[slot - 1] ?? '', paths.test);
    return { slot, keyId: key.keyId, publicKey: key.publicKey, file };
  });
  for (const key of made) {
    writeFileSync(
      join(paths.pubDir, `root-${key.slot}.pub`),
      canonicalJson({
        schema: 1,
        role: 'root',
        slot: key.slot,
        key_id: key.keyId,
        public_key: key.publicKey,
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

/** The current `keys.json`, checked against the roots; `null` when there is none yet. */
export function readKeys(paths: KeyPaths, roots: RootKeys): KeysJson | null {
  const file = join(paths.pubDir, 'keys.json');
  if (!existsSync(file)) return null;
  const bytes = readFileSync(file);
  const sig = existsSync(`${file}.sig`) ? readFileSync(`${file}.sig`, 'utf8') : '';
  if (verifiedBy(bytes, sig, new Map(roots.keys.map((k) => [k.key_id, k.public_key]))) === null) {
    throw new Error(`${file}: no root signature verifies; restore it from git before going on`);
  }
  return KeysJson.parse(JSON.parse(bytes.toString('utf8')));
}

function requireRoot(root: RootKey, roots: RootKeys): void {
  if (!roots.keys.some((k) => k.key_id === root.keyId && k.public_key === root.publicKey)) {
    throw new Error(`root key ${root.keyId} is not root-1.pub or root-2.pub`);
  }
}

/** What a `keys.json` change takes besides the root. */
export interface KeysChange {
  readonly now: number;
  /** `expires` in days (at most 120). */
  readonly keysDays: number;
  readonly indexFloor?: number;
}

function writeKeys(paths: KeyPaths, root: RootKey, keys: KeysJson): void {
  const bytes = Buffer.from(canonicalJson(keys));
  writeFileSync(join(paths.pubDir, 'keys.json'), bytes);
  writeFileSync(join(paths.pubDir, 'keys.json.sig'), signatureFile(bytes, [root]));
}

function nextKeys(
  previous: KeysJson | null,
  online: KeysJson['online'],
  change: KeysChange,
): KeysJson {
  if (!(change.keysDays >= 1 && change.keysDays <= KEYS_MAX_DAYS)) {
    throw new Error(`keys.json may expire at most ${KEYS_MAX_DAYS} days ahead`);
  }
  if (online.length === 0) throw new Error('keys.json needs at least one online key');
  if (online.length > MAX_ONLINE)
    throw new Error(`at most ${MAX_ONLINE} online keys; revoke one first`);
  return {
    schema: 1,
    version: (previous?.version ?? 0) + 1,
    expires: instant(change.now + change.keysDays * DAY_MS),
    ...(change.indexFloor !== undefined && { index_floor: change.indexFloor }),
    online,
  };
}

/**
 * Adds a new online key valid `days` (at most 90) and re-signs `keys.json`; expired online keys are
 * dropped. The secret value (`bhreg1.<key id>.<base64 PKCS#8>`) goes to `secretOut` (a new file,
 * 0600), never anywhere else.
 */
export function addOnlineKey(
  paths: KeyPaths,
  root: RootKey,
  secretOut: string,
  days: number,
  change: KeysChange,
): { readonly keyId: string; readonly notAfter: string; readonly keys: KeysJson } {
  if (!(days >= 1 && days <= ONLINE_KEY_MAX_DAYS)) {
    throw new Error(`an online key is valid at most ${ONLINE_KEY_MAX_DAYS} days`);
  }
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

/** Re-signs `keys.json` with a new version and expiry, optionally without the online key `revoke`. */
export function resignKeys(
  paths: KeyPaths,
  root: RootKey,
  change: KeysChange & { readonly revoke?: string },
): KeysJson {
  const roots = loadRoots(paths);
  requireRoot(root, roots);
  const previous = readKeys(paths, roots);
  if (previous === null) throw new Error('there is no keys.json yet: run online-key first');
  if (change.revoke !== undefined && !previous.online.some((k) => k.key_id === change.revoke)) {
    throw new Error(`keys.json lists no online key ${change.revoke}`);
  }
  const online = previous.online.filter(
    (k) => k.key_id !== change.revoke && Date.parse(k.not_after) > change.now,
  );
  const keys = nextKeys(previous, online, change);
  writeKeys(paths, root, keys);
  return keys;
}
