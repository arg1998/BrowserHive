/** @module scripts/registry/check — what `registry-build.ts` checks before it writes or a pull request merges (spec 13 §10.7, D-81): every pack and every archived version against the schema and refinements (core's `loadPackBytes`), canonical JSON, the version metadata and `registry/state.json`, the size caps, the root keys and `keys.json`, the pinned trust root, and against a base commit (read with `git`): a changed pack has a higher version, a published version is never changed or removed, new versions are above every published one, and each change is classified (`classifyPackChange`). The registry itself is read from the tree only, never from history, so a squash merge changes nothing. */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SitePackV1 } from '@browserhive/contracts/site-packs';
import {
  classifyPackChange,
  loadPackBytes,
  NO_TEMPLATES,
  type PackChangeClassification,
} from '@browserhive/core/server';
import { z } from 'zod';
import {
  type CollectedRegistry,
  canonicalJson,
  collectRegistry,
  fsReader,
  INDEX_MAX_BYTES,
  NOTES_MAX,
  type RootKeys,
  readRootKeys,
  readState,
  type TreeReader,
  verifiedBy,
} from '../registry-common.mjs';

/** `registry/versions/<id>.json`. */
const VersionsFile = z.strictObject({
  schema: z.literal(1),
  versions: z.record(
    z.string().regex(/^(?:[1-9]\d{0,5}|1000000)$/),
    z.strictObject({
      sha256: z.string().regex(/^[0-9a-f]{64}$/),
      released: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      notes: z.string().min(1).max(NOTES_MAX),
      revoked: z.literal(true).optional(),
    }),
  ),
});

/** The file whose pinned list must equal `registry/keys/root-*.pub`. */
export const TRUST_ROOT = 'packages/core/src/infra/site-packs/trust-root.ts';

const PINNED_RE = /\{ keyId: '([0-9a-f]{16})', publicKey: '([A-Za-z0-9+/=]{44})' \}/g;

/** The keys pinned in `repo`'s `trust-root.ts`, read as text (`--repo` may be another checkout). */
export function pinnedKeysIn(repo: string): { keyId: string; publicKey: string }[] {
  const text = readFileSync(join(repo, TRUST_ROOT), 'utf8');
  const block = text.slice(
    text.indexOf('// BEGIN PINNED ROOT KEYS'),
    text.indexOf('// END PINNED ROOT KEYS'),
  );
  return [...block.matchAll(PINNED_RE)].map((m) => ({ keyId: m[1] ?? '', publicKey: m[2] ?? '' }));
}

/** One pack's change against the base. */
export interface PackChange {
  readonly id: string;
  readonly from: number | null;
  readonly to: number | null;
  readonly classification: PackChangeClassification['classification'] | 'removed';
  readonly changes: PackChangeClassification['changes'];
}

/** What {@link checkRegistry} found. */
export interface RegistryCheck {
  readonly collected: CollectedRegistry;
  readonly errors: readonly string[];
  readonly notes: readonly string[];
  readonly roots: RootKeys;
  readonly keys: {
    readonly version: number;
    readonly expires: string;
    readonly online: readonly { readonly key_id: string; readonly not_after: string }[];
  } | null;
  /** `null` without a base. */
  readonly changes: readonly PackChange[] | null;
}

function packOf(
  bytes: Uint8Array,
  id: string,
  origin: string,
  errors: string[],
): SitePackV1 | null {
  const loaded = loadPackBytes(bytes, { origin, binaryVersion: null, expectedId: id });
  if (loaded.ok) return loaded.value.pack;
  errors.push(`${origin}: ${loaded.error.reason}: ${loaded.error.detail}`);
  return null;
}

function canonicalProblem(path: string, text: string): string | null {
  try {
    return canonicalJson(JSON.parse(text)) === text
      ? null
      : `${path}: not canonical JSON (sorted keys, two spaces, final newline; bun scripts/registry-build.ts --sync)`;
  } catch {
    return `${path}: not JSON`;
  }
}

const StateFile = z.strictObject({
  schema: z.literal(1),
  index_version: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  note: z.string().max(500).optional(),
});

function checkJsonFile(
  reader: TreeReader,
  path: string,
  schema: z.ZodType,
  errors: string[],
): void {
  const bytes = reader.read(path);
  if (bytes === null) {
    errors.push(`${path}: missing`);
    return;
  }
  const text = bytes.toString('utf8');
  const problem = canonicalProblem(path, text);
  if (problem !== null) {
    errors.push(problem);
    return;
  }
  const parsed = schema.safeParse(JSON.parse(text));
  if (!parsed.success) {
    errors.push(
      `${path}: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`,
    );
  }
}

function checkFiles(reader: TreeReader, collected: CollectedRegistry, errors: string[]): void {
  for (const [id, bytes] of collected.current) {
    const path = `registry/packs/${id}.json`;
    const problem = canonicalProblem(path, Buffer.from(bytes).toString('utf8'));
    if (problem !== null) errors.push(problem);
    packOf(bytes, id, path, errors);
    checkJsonFile(reader, `registry/versions/${id}.json`, VersionsFile, errors);
  }
  // Every archived version, listed in the index or not, is a valid canonical pack.
  for (const [id, shas] of collected.listed) {
    for (const [v, sha] of shas) {
      const path = `registry/archive/${id}/${sha}.json`;
      const bytes = reader.read(path);
      if (bytes === null) continue;
      const problem = canonicalProblem(path, bytes.toString('utf8'));
      if (problem !== null) errors.push(problem);
      if (!collected.current.get(id)?.equals(bytes))
        packOf(bytes, id, `${id} v${v} (${path})`, errors);
    }
  }
  for (const name of reader.list('registry/versions')) {
    const id = name.replace(/\.json$/, '');
    if (!name.endsWith('.json') || !collected.current.has(id)) {
      errors.push(`registry/versions/${name}: no registry/packs/${id}.json`);
    }
  }
  checkJsonFile(reader, 'registry/state.json', StateFile, errors);
  // The signed index adds version, issued_at and expires: well under 200 bytes.
  const size = Buffer.byteLength(canonicalJson(collected.index)) + 200;
  if (size > INDEX_MAX_BYTES)
    errors.push(`index.json would be ${size} bytes; at most ${INDEX_MAX_BYTES}`);
}

function checkKeys(
  repo: string,
  errors: string[],
  notes: string[],
): Pick<RegistryCheck, 'roots' | 'keys'> {
  const dir = join(repo, 'registry', 'keys');
  const roots = readRootKeys(dir);
  for (const problem of roots.problems) errors.push(`registry/keys: ${problem}`);
  if (roots.test) errors.push('registry/keys: a test root key never belongs in the repository');
  const pinned = pinnedKeysIn(repo)
    .map((k) => `${k.keyId}:${k.publicKey}`)
    .sort();
  const files = roots.keys.map((k) => `${k.key_id}:${k.public_key}`).sort();
  if (pinned.join() !== files.join()) {
    errors.push(
      `${TRUST_ROOT} does not pin registry/keys/root-*.pub (registry-keys.mjs init-roots)`,
    );
  }
  if (roots.placeholder)
    notes.push(
      'Root keys: placeholders (the key ceremony has not run); nothing can be signed yet.',
    );
  const keysPath = join(dir, 'keys.json');
  if (!existsSync(keysPath)) return { roots, keys: null };
  if (roots.keys.length !== 2) {
    errors.push('registry/keys/keys.json exists but the root keys are not both set');
    return { roots, keys: null };
  }
  const bytes = readFileSync(keysPath);
  const sig = existsSync(`${keysPath}.sig`) ? readFileSync(`${keysPath}.sig`, 'utf8') : '';
  const signer = verifiedBy(bytes, sig, new Map(roots.keys.map((k) => [k.key_id, k.public_key])));
  if (signer === null) errors.push('registry/keys/keys.json: no root signature verifies');
  const keys = z
    .object({
      version: z.number(),
      expires: z.string(),
      online: z.array(z.object({ key_id: z.string(), not_after: z.string() })),
    })
    .safeParse(JSON.parse(bytes.toString('utf8')));
  if (!keys.success) {
    errors.push('registry/keys/keys.json: not a keys file');
    return { roots, keys: null };
  }
  const soon = Date.now() + 30 * 24 * 3_600_000;
  if (Date.parse(keys.data.expires) < soon)
    notes.push(`keys.json expires ${keys.data.expires}: re-sign it.`);
  for (const key of keys.data.online) {
    if (Date.parse(key.not_after) < soon)
      notes.push(`Online key ${key.key_id} is valid until ${key.not_after}: rotate it.`);
  }
  return { roots, keys: keys.data };
}

function compare(
  head: CollectedRegistry,
  base: CollectedRegistry,
  baseState: number | null,
  headState: number | null,
  errors: string[],
): PackChange[] {
  const changes: PackChange[] = [];
  if (baseState !== null && headState !== null && headState < baseState) {
    errors.push(`registry/state.json: index_version went down from ${baseState} to ${headState}`);
  }
  for (const [id, before] of base.listed) {
    const after = head.listed.get(id);
    if (after === undefined) continue; // the pack was removed (reported below)
    for (const [v, sha] of before) {
      const now = after.get(v);
      if (now === undefined) {
        errors.push(`${id} v${v}: a published version cannot be removed (mark it "revoked": true)`);
      } else if (now !== sha) {
        errors.push(
          `${id} v${v}: a published version's content changed; give the change a new version`,
        );
      }
    }
    const highest = Math.max(0, ...before.keys());
    for (const v of after.keys()) {
      if (!before.has(v) && v <= highest) {
        errors.push(`${id} v${v}: a new version must be above every published one (v${highest})`);
      }
    }
  }
  for (const [id, bytes] of head.current) {
    const headPack = packOf(bytes, id, `registry/packs/${id}.json`, []);
    const baseBytes = base.current.get(id);
    const basePack = baseBytes === undefined ? null : packOf(baseBytes, id, `base ${id}`, []);
    if (headPack === null) continue;
    const same =
      basePack !== null &&
      canonicalJson(basePack) === canonicalJson(headPack) &&
      basePack.version === headPack.version;
    if (same) continue;
    if (basePack !== null && headPack.version <= basePack.version) {
      errors.push(`${id}: changed, so its version must be above v${basePack.version}`);
    }
    const classified = classifyPackChange(basePack, headPack, NO_TEMPLATES);
    changes.push({ id, from: basePack?.version ?? null, to: headPack.version, ...classified });
  }
  for (const id of base.current.keys()) {
    if (!head.current.has(id)) {
      changes.push({ id, from: null, to: null, classification: 'removed', changes: [] });
    }
  }
  return changes;
}

/** The tree of commit `ref` in `repo`, read with `git` (the base of a pull request). */
export function gitReader(repo: string, ref: string): TreeReader {
  const git = (args: string[]): Buffer | null => {
    try {
      return execFileSync('git', ['-C', repo, ...args], {
        maxBuffer: 64 * 1024 * 1024,
        stdio: ['ignore', 'pipe', 'ignore'],
      });
    } catch {
      return null;
    }
  };
  return {
    read: (path) => git(['show', `${ref}:${path}`]),
    list: (dir) =>
      (git(['ls-tree', '--name-only', `${ref}:${dir}`])?.toString('utf8') ?? '')
        .split('\n')
        .filter((n) => n !== '')
        .sort(),
  };
}

/** Checks `registry/` in `repo`'s working tree, and against commit `base` when given. */
export function checkRegistry(repo: string, base: string | null): RegistryCheck {
  const reader = fsReader(repo);
  const collected = collectRegistry(reader);
  const errors = [...collected.problems];
  const notes: string[] = [];
  checkFiles(reader, collected, errors);
  const keys = checkKeys(repo, errors, notes);
  let changes: PackChange[] | null = null;
  if (base !== null) {
    const baseReader = gitReader(repo, base);
    changes = compare(
      collected,
      collectRegistry(baseReader),
      readState(baseReader)?.index_version ?? null,
      readState(reader)?.index_version ?? null,
      errors,
    );
  }
  return { collected, errors, notes, ...keys, changes };
}
