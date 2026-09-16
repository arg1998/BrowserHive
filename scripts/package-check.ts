/** @module scripts/package-check — publint + attw + tarball contents + installed smoke (spec 06 §4, §6 "package"). */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = join(import.meta.dir, '..');
const pkgDir = join(root, 'packages/browserhive');

function run(
  cmd: string,
  args: string[],
  cwd = root,
  env: Record<string, string> = {},
): { status: number; out: string } {
  const res = spawnSync(cmd, args, { cwd, encoding: 'utf8', env: { ...process.env, ...env } });
  return { status: res.status ?? 1, out: `${res.stdout}${res.stderr}` };
}
function step(name: string, r: { status: number; out: string }): void {
  if (r.status !== 0) {
    console.error(`package-check: ${name} failed\n${r.out}`);
    process.exit(1);
  }
  console.log(`package-check: ${name} ok`);
}

for (const f of ['dist/bin.js', 'dist/index.js', 'dist/index.d.ts', 'dist/dashboard/index.html']) {
  if (!existsSync(join(pkgDir, f))) {
    console.error(`package-check: missing ${f}; run \`bun run build\` first`);
    process.exit(1);
  }
}
step('publint', run('bunx', ['publint', pkgDir]));
step('attw', run('bunx', ['@arethetypeswrong/cli', '--pack', pkgDir, '--profile', 'esm-only']));

const packDir = mkdtempSync(join(tmpdir(), 'bh-pack-'));
try {
  step('pack', run('bun', ['pm', 'pack', '--destination', packDir], pkgDir));
  const tgz = run('bash', ['-lc', `ls ${packDir}/*.tgz`]).out.trim();
  const listing = run('tar', ['-tzf', tgz]).out;
  for (const banned of ['package/src/', 'package/test/', '.map', '.tsbuildinfo']) {
    if (listing.includes(banned)) {
      console.error(`package-check: tarball contains ${banned}`);
      process.exit(1);
    }
  }
  for (const required of [
    'package/dist/bin.js',
    'package/dist/index.js',
    'package/dist/index.d.ts',
    'package/dist/dashboard/index.html',
    'package/README.md',
    'package/LICENSE',
  ]) {
    if (!listing.includes(required)) {
      console.error(`package-check: tarball missing ${required}`);
      process.exit(1);
    }
  }
  console.log('package-check: tarball contents ok');

  // Undeclared externals: every bare import in dist/*.js must be declared in dependencies.
  const manifest: {
    dependencies?: Record<string, string>;
    optionalDependencies?: Record<string, string>;
  } = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8'));
  const declared = new Set(
    Object.keys({ ...manifest.dependencies, ...manifest.optionalDependencies }),
  );
  const undeclared = new Set<string>();
  for (const file of ['dist/bin.js', 'dist/index.js']) {
    const src = readFileSync(join(pkgDir, file), 'utf8');
    for (const m of src.matchAll(
      /from\s+["']([^"'./][^"']*)["']|import\s*\(\s*["']([^"'./][^"']*)["']\s*\)/g,
    )) {
      const spec = m[1] ?? m[2] ?? '';
      if (spec.startsWith('node:') || spec.startsWith('bun:') || spec === 'bun') continue;
      const name = spec.startsWith('@')
        ? spec.split('/').slice(0, 2).join('/')
        : (spec.split('/')[0] ?? spec);
      if (!declared.has(name)) undeclared.add(name);
    }
  }
  if (undeclared.size > 0) {
    console.error(`package-check: undeclared externals in dist: ${[...undeclared].join(', ')}`);
    process.exit(1);
  }
  console.log('package-check: externals declared ok');

  step('smoke-installed', run('bun', [join(root, 'scripts/smoke-installed.ts'), tgz]));
  step('smoke-programmatic', run('bun', [join(root, 'scripts/smoke-programmatic.ts'), tgz]));
} finally {
  rmSync(packDir, { recursive: true, force: true });
}
