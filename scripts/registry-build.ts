/** @module scripts/registry-build — builds the unsigned site-pack registry from `registry/` (spec 13 §10.1, §10.7): content-addressed pack files `packs/<id>/<sha256>.json`, an unsigned `index.json` (`{schema, packs}`; `registry-sign.mjs` adds the version, dates and signature) and the root-signed `keys.json` when it exists. At most ten versions per pack, from `registry/versions/<id>.json` and the git history. Every pack and listed version is checked first (`registry/check.ts`).
 *
 *   bun scripts/registry-build.ts --out dist/registry/v1 [--summary <file>]
 *   bun scripts/registry-build.ts --check [--base <commit>] [--summary <file>]   validate; with a
 *       base, also the version rules and each change's classification (the PR job summary)
 *   bun scripts/registry-build.ts --format     rewrite registry/packs and registry/versions canonically
 *
 * `--repo <dir>` points at another checkout (tests).
 */
import {
  appendFileSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { checkRegistry } from './registry/check.ts';
import { summaryOf } from './registry/summary.ts';
import { canonicalJson, requireFullHistory } from './registry-common.mjs';

function flag(name: string): string | null {
  const i = process.argv.indexOf(`--${name}`);
  if (i < 0) return null;
  const value = process.argv[i + 1];
  if (value === undefined || value.startsWith('--')) {
    console.error(`registry-build: --${name} needs a value`);
    process.exit(64);
  }
  return value;
}

const has = (name: string): boolean => process.argv.includes(`--${name}`);
const repo = resolve(flag('repo') ?? join(import.meta.dir, '..'));

if (has('format')) {
  for (const dir of ['packs', 'versions']) {
    const full = join(repo, 'registry', dir);
    for (const name of readdirSync(full).filter((n) => n.endsWith('.json'))) {
      const path = join(full, name);
      writeFileSync(path, canonicalJson(JSON.parse(readFileSync(path, 'utf8'))));
    }
  }
  console.log('registry-build: formatted registry/packs and registry/versions');
  process.exit(0);
}

const out = flag('out');
const base = flag('base');
if (out === null && !has('check')) {
  console.error('usage: registry-build.ts --out <dir> | --check [--base <commit>] | --format');
  process.exit(64);
}

try {
  requireFullHistory(repo);
} catch (error) {
  console.error(`registry-build: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}

const check = checkRegistry(repo, base);
const report = summaryOf(check, base);
const summaryFile = flag('summary');
if (summaryFile !== null) appendFileSync(summaryFile, `${report}\n`);
console.log(report);
if (check.errors.length > 0) process.exit(1);

if (out !== null) {
  const target = resolve(out);
  rmSync(target, { recursive: true, force: true });
  mkdirSync(target, { recursive: true });
  writeFileSync(join(target, 'index.json'), canonicalJson(check.collected.index));
  for (const [path, bytes] of check.collected.files) {
    mkdirSync(dirname(join(target, path)), { recursive: true });
    writeFileSync(join(target, path), bytes);
  }
  if (check.keys !== null) {
    for (const name of ['keys.json', 'keys.json.sig']) {
      writeFileSync(join(target, name), readFileSync(join(repo, 'registry', 'keys', name)));
    }
  }
  console.log(`registry-build: ${check.collected.files.size} pack file(s) -> ${target}`);
}
