/** @module scripts/installable-app-check — the installable-app assertions of the package gate (spec
 * 09 §3.6, D-49) on a built dashboard directory: the manifest, worker, precache list, offline page
 * and icons exist; the precache is complete and within budget; `sw.js` is a classic script without
 * zod; the icon stamp never ships. `package-check.ts` runs it on `packages/browserhive/dist/dashboard`;
 * `bun scripts/installable-app-check.ts [dir]` runs it alone (default `packages/dashboard/dist`).
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, posix } from 'node:path';

/** The precache budget (04 §18.5.6), the same as the build plugin's. */
const PRECACHE_BUDGET_BYTES = 300 * 1024;

/** Files every bundle with the installable app has (04 §18.1). */
export const REQUIRED_FILES = [
  'manifest.webmanifest',
  'sw.js',
  'sw-precache.json',
  'offline.html',
  'icons/app.svg',
  'icons/app-192.png',
  'icons/app-512.png',
  'icons/maskable-192.png',
  'icons/maskable-512.png',
  'icons/apple-touch-icon.png',
] as const;

function filesUnder(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? filesUnder(path) : [path];
  });
}

/** Problems with the installable app in a built dashboard directory (empty when it may ship). */
export function installableAppProblems(dir: string): string[] {
  const problems: string[] = [];
  for (const file of REQUIRED_FILES) {
    if (!existsSync(join(dir, file))) problems.push(`missing ${file}`);
  }
  if (filesUnder(dir).some((path) => path.endsWith('icons.stamp.json'))) {
    problems.push('icons.stamp.json is in the bundle');
  }
  if (!existsSync(join(dir, 'sw-precache.json')) || !existsSync(join(dir, 'sw.js'))) {
    return problems;
  }
  const precache = JSON.parse(readFileSync(join(dir, 'sw-precache.json'), 'utf8')) as {
    version: string;
    paths: string[];
  };
  const script = readFileSync(join(dir, 'sw.js'), 'utf8');
  if (!script.includes(precache.version)) {
    problems.push(`sw.js lacks the precache version ${precache.version}`);
  }
  if (/\bimportScripts\b/.test(script)) problems.push('sw.js calls importScripts');
  if (/\bimport\b/.test(script)) problems.push('sw.js contains an import');
  if (/zod/i.test(script)) problems.push('sw.js contains zod');
  if (!precache.paths.includes('/offline.html')) problems.push('the precache lacks /offline.html');
  const listed = new Set(precache.paths);
  let total = 0;
  for (const path of precache.paths) {
    const file = join(dir, path.slice(1));
    if (!existsSync(file)) {
      problems.push(`precached ${path} is missing`);
      continue;
    }
    total += statSync(file).size;
    if (!path.endsWith('.css')) continue;
    const css = readFileSync(file, 'utf8');
    for (const match of css.matchAll(/url\(\s*(['"]?)([^'")]+)\1\s*\)/g)) {
      const target = match[2] ?? '';
      if (target.startsWith('data:') || target.startsWith('#')) continue;
      const resolved = target.startsWith('/')
        ? target
        : posix.join(posix.dirname(path), target.split(/[?#]/)[0] ?? '');
      if (!listed.has(resolved)) problems.push(`${path} references ${target}, not precached`);
    }
  }
  if (total > PRECACHE_BUDGET_BYTES) {
    problems.push(`the precache is ${total} bytes; the budget is ${PRECACHE_BUDGET_BYTES}`);
  }
  return problems;
}

if (import.meta.main) {
  const dir = process.argv[2] ?? join(dirname(import.meta.dir), 'packages/dashboard/dist');
  const problems = installableAppProblems(dir);
  if (problems.length > 0) {
    console.error(`installable-app-check failed for ${dir}:\n  ${problems.join('\n  ')}`);
    process.exit(1);
  }
  console.log(`installable-app-check: ${dir} ok`);
}
