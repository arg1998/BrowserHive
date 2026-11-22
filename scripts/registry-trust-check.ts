/** @module scripts/registry-trust-check — the release gate on the registry trust root (spec 13 §10.2, T4a): `bun run release:publish` runs it before `changeset publish`, and it refuses a release whose pinned root keys are the placeholders (the key ceremony has not run), a throwaway test key, not exactly the two keys of `registry/keys/root-*.pub`, or not what `trust-root.ts` pins. Exit 0 when the release may ship, 1 otherwise. */
import { join, resolve } from 'node:path';
import { keyIdOf, PINNED_TRUST_ROOT } from '@browserhive/core/server';
import { pinnedKeysIn } from './registry/check.ts';
import { readRootKeys } from './registry-common.mjs';

const i = process.argv.indexOf('--repo');
const repo = resolve(i >= 0 ? (process.argv[i + 1] ?? '.') : join(import.meta.dir, '..'));
const roots = readRootKeys(join(repo, 'registry', 'keys'));
const problems: string[] = [...roots.problems];
if (roots.placeholder) {
  problems.push(
    'registry/keys/root-*.pub are placeholders: run the key ceremony (docs/contributing/registry.md) first',
  );
}
if (roots.test) problems.push('registry/keys holds a throwaway test root key');
if (!roots.placeholder && roots.keys.length !== 2)
  problems.push('registry/keys needs both root-1.pub and root-2.pub');
const files = roots.keys.map((k) => `${k.key_id}:${k.public_key}`).sort();
const pinnedText = pinnedKeysIn(repo)
  .map((k) => `${k.keyId}:${k.publicKey}`)
  .sort();
if (pinnedText.join() !== files.join())
  problems.push('trust-root.ts does not pin registry/keys/root-*.pub');
// The binary that is about to be built must pin them too (this checkout's core).
if (resolve(join(import.meta.dir, '..')) === repo) {
  const built = PINNED_TRUST_ROOT.keys.map((k) => `${k.keyId}:${k.publicKey}`).sort();
  if (built.join() !== files.join())
    problems.push('the core module pins other keys than registry/keys');
  for (const key of PINNED_TRUST_ROOT.keys) {
    if (keyIdOf(key.publicKey) !== key.keyId) problems.push(`pinned key ${key.keyId}: wrong id`);
  }
}

if (problems.length > 0) {
  console.error('registry-trust-check: this release would not trust the published registry:');
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
console.log(
  `registry-trust-check: release pins root keys ${roots.keys.map((k) => k.key_id).join(', ')}`,
);
