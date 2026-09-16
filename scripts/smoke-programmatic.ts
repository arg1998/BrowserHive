/** @module scripts/smoke-programmatic — `import { createServer } from 'browserhive'` from the packed tarball (spec 06 §6). */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tarball = process.argv[2];
if (!tarball) {
  console.error('usage: smoke-programmatic.ts <tarball>');
  process.exit(64);
}
const dir = mkdtempSync(join(tmpdir(), 'bh-smoke-prog-'));
try {
  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify({ name: 'smoke', private: true, type: 'module' }),
  );
  const add = spawnSync('bun', ['add', tarball], { cwd: dir, encoding: 'utf8' });
  if (add.status !== 0) throw new Error(`bun add failed\n${add.stdout}${add.stderr}`);
  writeFileSync(
    join(dir, 'main.ts'),
    `import { createServer } from 'browserhive';
const server = await createServer({ port: 0, dataDir: '${join(dir, 'data').replace(/\\/g, '\\\\')}', env: {}, configFile: false });
await server.listen();
const res = await fetch(server.url + '/health');
const body = await res.json();
if (body.status !== 'ready') throw new Error('not ready: ' + JSON.stringify(body));
await server.stop();
await server.stop();
console.log('smoke-programmatic: ok ' + server.url);
`,
  );
  const run = spawnSync('bun', ['main.ts'], { cwd: dir, encoding: 'utf8' });
  process.stdout.write(run.stdout);
  if (run.status !== 0) {
    console.error(run.stderr);
    process.exit(1);
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}
