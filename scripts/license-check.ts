/** @module scripts/license-check — allows only permissive licenses in production dependencies (spec 05 §8). */
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';

const ALLOWED = new Set([
  'MIT',
  'Apache-2.0',
  'BSD-2-Clause',
  'BSD-3-Clause',
  'ISC',
  '0BSD',
  'CC0-1.0',
  'Unlicense',
  'MPL-2.0',
  'OFL-1.1',
  'BlueOak-1.0.0',
  'Python-2.0',
  'CC-BY-4.0',
  'MIT-0',
  'Zlib',
]);
const root = join(import.meta.dir, '..');
const targets = ['packages/browserhive/package.json', 'packages/dashboard/package.json'];
const problems: string[] = [];
const seen = new Set<string>();

function licenseOf(pkgDir: string): string {
  const manifest: { license?: unknown; licenses?: unknown } = JSON.parse(
    readFileSync(join(pkgDir, 'package.json'), 'utf8'),
  );
  if (typeof manifest.license === 'string') return manifest.license;
  if (manifest.license && typeof manifest.license === 'object' && 'type' in manifest.license) {
    const t = (manifest.license as { type?: unknown }).type;
    if (typeof t === 'string') return t;
  }
  if (Array.isArray(manifest.licenses)) {
    return manifest.licenses.map((l: { type?: string }) => l.type ?? '?').join(' OR ');
  }
  return 'UNKNOWN';
}

function allowed(expr: string): boolean {
  // Accept SPDX OR-expressions when any alternative is allowed; AND when all are.
  const orParts = expr.replace(/^\(|\)$/g, '').split(/\s+OR\s+/i);
  return orParts.some((part) =>
    part.split(/\s+AND\s+/i).every((p) => ALLOWED.has(p.trim().replace(/\+$/, ''))),
  );
}

function resolvePkg(name: string, from: string): string | null {
  let dir = from;
  for (;;) {
    const candidate = join(dir, 'node_modules', name);
    if (existsSync(join(candidate, 'package.json'))) return realpathSync(candidate);
    const parent = join(dir, '..');
    if (parent === dir) return null;
    dir = parent;
  }
}

function walk(name: string, from: string): void {
  const dir = resolvePkg(name, from);
  if (!dir) {
    problems.push(`${name}: not installed (from ${from})`);
    return;
  }
  const manifest: {
    version?: string;
    dependencies?: Record<string, string>;
    optionalDependencies?: Record<string, string>;
  } = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
  const key = `${name}@${manifest.version ?? '?'}`;
  if (seen.has(key)) return;
  seen.add(key);
  const lic = licenseOf(dir);
  if (!allowed(lic)) problems.push(`${key}: ${lic}`);
  for (const dep of Object.keys({ ...manifest.dependencies, ...manifest.optionalDependencies })) {
    walk(dep, dir);
  }
}

for (const t of targets) {
  const manifest: {
    dependencies?: Record<string, string>;
    optionalDependencies?: Record<string, string>;
  } = JSON.parse(readFileSync(join(root, t), 'utf8'));
  for (const dep of Object.keys({ ...manifest.dependencies, ...manifest.optionalDependencies })) {
    if (dep.startsWith('@browserhive/')) continue;
    walk(dep, join(root, t, '..'));
  }
}
if (problems.length > 0) {
  console.error('license-check: disallowed or unknown licenses:');
  for (const p of problems) console.error(`  ${p}`);
  process.exit(1);
}
console.log(`license-check: ${seen.size} packages, all allowed`);
