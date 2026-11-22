/** @module scripts/registry/check — what `registry-build.ts` checks before it writes or a pull request merges (spec 13 §10.7): every pack and every listed version against the schema and refinements (core's `loadPackBytes`), canonical JSON, the version metadata, the size caps, the root keys and `keys.json`, the pinned trust root, and against a base commit: a changed pack has a higher version, listed versions keep their bytes, only the current version is new, and each change is classified (`classifyPackChange`). */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
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
  INDEX_MAX_BYTES,
  NOTES_MAX,
  packHistory,
  type RootKeys,
  readRootKeys,
  sha256Hex,
  verifiedBy,
} from '../registry-common.mjs';

/** `registry/versions/<id>.json`. */
const VersionsFile = z.strictObject({
  schema: z.literal(1),
  versions: z.record(
    z.string().regex(/^[1-9]\d{0,6}$/),
    z.strictObject({
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
      : `${path}: not canonical JSON (sorted keys, two spaces, final newline; bun scripts/registry-build.ts --format)`;
  } catch {
    return `${path}: not JSON`;
  }
}

function checkFiles(repo: string, collected: CollectedRegistry, errors: string[]): void {
  for (const [id, bytes] of collected.current) {
    const path = `registry/packs/${id}.json`;
    const problem = canonicalProblem(path, Buffer.from(bytes).toString('utf8'));
    if (problem !== null) errors.push(problem);
    packOf(bytes, id, path, errors);
  }
  for (const pack of collected.index.packs) {
    for (const entry of pack.versions) {
      const bytes = collected.files.get(entry.path);
      if (bytes !== undefined && !collected.current.get(pack.id)?.equals(bytes)) {
        packOf(bytes, pack.id, `${pack.id} v${entry.v} (from history)`, errors);
      }
    }
  }
  const versionsDir = join(repo, 'registry', 'versions');
  for (const name of existsSync(versionsDir) ? readdirSync(versionsDir).sort() : []) {
    const path = `registry/versions/${name}`;
    const id = name.replace(/\.json$/, '');
    if (!name.endsWith('.json') || !collected.current.has(id)) {
      errors.push(`${path}: no registry/packs/${id}.json`);
      continue;
    }
    const text = readFileSync(join(versionsDir, name), 'utf8');
    const problem = canonicalProblem(path, text);
    if (problem !== null) {
      errors.push(problem);
      continue;
    }
    const parsed = VersionsFile.safeParse(JSON.parse(text));
    if (!parsed.success) {
      errors.push(
        `${path}: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`,
      );
    }
  }
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
      `${TRUST_ROOT} does not pin registry/keys/root-*.pub (registry-keys.ts init-roots)`,
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
  repo: string,
  baseRef: string,
  head: CollectedRegistry,
  base: CollectedRegistry,
  errors: string[],
): PackChange[] {
  const changes: PackChange[] = [];
  const baseListed = new Map(
    base.index.packs.map((p) => [p.id, new Map(p.versions.map((v) => [v.v, v.sha256]))]),
  );
  for (const [id, bytes] of head.current) {
    const headPack = packOf(bytes, id, `registry/packs/${id}.json`, []);
    const baseBytes = base.current.get(id);
    const basePack = baseBytes === undefined ? null : packOf(baseBytes, id, `base ${id}`, []);
    if (headPack === null) continue;
    const listed = head.index.packs.find((p) => p.id === id)?.versions ?? [];
    const before = baseListed.get(id);
    for (const entry of listed) {
      const sha = before?.get(entry.v);
      if (sha !== undefined && sha !== entry.sha256) {
        errors.push(
          `${id} v${entry.v}: a published version's content changed; give the change a new version`,
        );
      }
      // A newly listed earlier version must be content the base already held: commits inside the
      // pull request cannot publish what its final diff does not show.
      const committed = packHistory(repo, baseRef, id).get(entry.v);
      if (
        sha === undefined &&
        entry.v !== headPack.version &&
        (committed === undefined || sha256Hex(committed) !== entry.sha256)
      ) {
        errors.push(
          `${id} v${entry.v}: only the current version (v${headPack.version}), or a version the base already held, can be newly listed`,
        );
      }
    }
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

/**
 * Checks `registry/` in `repo` (the working tree and HEAD's history), and against `base` when
 * given.
 */
export function checkRegistry(repo: string, base: string | null): RegistryCheck {
  const collected = collectRegistry(repo);
  const errors = [...collected.problems];
  const notes: string[] = [];
  checkFiles(repo, collected, errors);
  const keys = checkKeys(repo, errors, notes);
  const changes =
    base === null ? null : compare(repo, base, collected, collectRegistry(repo, base), errors);
  return { collected, errors, notes, ...keys, changes };
}
