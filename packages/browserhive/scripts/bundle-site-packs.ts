/** @module browserhive/scripts/bundle-site-packs — copies the bundled site packs (`registry/packs/<id>.json` at the repository root, spec 13 §9.8, §10.9) into dist/site-packs/packs/ with a generated index.json ({release, built_at, packs: [{id, version, sha256, size, path}]}); every file must pass the schema and refinements, else the build fails. An empty or missing folder bundles no packs. */
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { type BundledIndex, issuesText, loadPackBytes } from '@browserhive/core/server';
import { z } from 'zod';

const here = join(import.meta.dir, '..');
const source = join(here, '../../registry/packs');
const target = join(here, 'dist/site-packs');

const release = z
  .object({ version: z.string() })
  .parse(JSON.parse(readFileSync(join(here, 'package.json'), 'utf8'))).version;

/** Reproducible builds set SOURCE_DATE_EPOCH (seconds); otherwise the build time. */
function builtAt(): number {
  const epoch = Number(process.env['SOURCE_DATE_EPOCH']);
  return Number.isFinite(epoch) && epoch > 0 ? epoch * 1000 : Date.now();
}

let names: string[] = [];
try {
  names = readdirSync(source)
    .filter((n) => n.endsWith('.json'))
    .sort();
} catch {
  names = [];
}

const packs: BundledIndex['packs'] = [];
const problems: string[] = [];
for (const name of names) {
  const bytes = new Uint8Array(readFileSync(join(source, name)));
  const id = name.slice(0, -'.json'.length);
  // The binary range is not checked here: a pack may already target the next release.
  const loaded = loadPackBytes(bytes, { origin: name, binaryVersion: null, expectedId: id });
  if (!loaded.ok) {
    problems.push(`${name}: ${issuesText(loaded.error.issues)}`);
    continue;
  }
  packs.push({
    id,
    version: loaded.value.pack.version,
    sha256: loaded.value.sha256,
    size: loaded.value.size,
    path: `packs/${id}.json`,
  });
}
if (problems.length > 0) {
  console.error(`bundle-site-packs: ${problems.length} invalid pack(s):`);
  for (const line of problems) console.error(`  ${line}`);
  process.exit(1);
}

rmSync(target, { recursive: true, force: true });
mkdirSync(join(target, 'packs'), { recursive: true });
for (const name of names) {
  writeFileSync(join(target, 'packs', name), readFileSync(join(source, name)));
}
const index: BundledIndex = { release, built_at: builtAt(), packs };
writeFileSync(join(target, 'index.json'), `${JSON.stringify(index, null, 2)}\n`);
console.log(`bundle-site-packs: ${packs.length} pack(s) -> ${target}`);
