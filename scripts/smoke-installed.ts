/** @module scripts/smoke-installed — installs the packed tarball into a clean project and exercises the CLI (spec 06 §6 "package"). */
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tarball = process.argv[2];
if (!tarball) {
  console.error('usage: smoke-installed.ts <tarball>');
  process.exit(64);
}
const dir = mkdtempSync(join(tmpdir(), 'bh-smoke-'));
const dataDir = join(dir, 'data');
function fail(msg: string): never {
  console.error(`smoke-installed: ${msg}`);
  rmSync(dir, { recursive: true, force: true });
  process.exit(1);
}
try {
  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify({ name: 'smoke', private: true, type: 'module' }),
  );
  const add = spawnSync('bun', ['add', tarball], { cwd: dir, encoding: 'utf8' });
  if (add.status !== 0) fail(`bun add failed\n${add.stdout}${add.stderr}`);
  const bin = join(dir, 'node_modules/.bin/browserhive');

  const version = spawnSync(bin, ['--version'], { cwd: dir, encoding: 'utf8' });
  if (version.status !== 0 || !/browserhive \d+\.\d+\.\d+/.test(version.stdout))
    fail(`--version: ${version.stdout}${version.stderr}`);
  const help = spawnSync(bin, ['--help'], { cwd: dir, encoding: 'utf8' });
  if (help.status !== 0 || !help.stdout.includes('USAGE'))
    fail(`--help: ${help.stdout}${help.stderr}`);

  // stdio handshake: initialize → tools/list → tools/call list_sessions
  const stdio = spawn(bin, ['serve', '--transport', 'stdio', '--dataDir', dataDir], { cwd: dir });
  let out = '';
  stdio.stdout.on('data', (d) => {
    out += String(d);
  });
  const send = (msg: unknown): void => {
    stdio.stdin.write(`${JSON.stringify(msg)}\n`);
  };
  const waitFor = (id: number, timeoutMs = 20_000): Promise<Record<string, unknown>> =>
    new Promise((resolve, reject) => {
      const started = Date.now();
      const tick = (): void => {
        for (const line of out.split('\n')) {
          if (!line.trim()) continue;
          try {
            const parsed = JSON.parse(line) as { id?: number };
            if (parsed.id === id) {
              resolve(parsed as Record<string, unknown>);
              return;
            }
          } catch {
            reject(new Error(`non-JSON on stdout: ${line}`));
            return;
          }
        }
        if (Date.now() - started > timeoutMs) reject(new Error(`timeout waiting for id ${id}`));
        else setTimeout(tick, 50);
      };
      tick();
    });
  send({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'smoke', version: '0' },
    },
  });
  const init = await waitFor(1);
  if (!('result' in init)) fail(`initialize failed: ${JSON.stringify(init)}`);
  send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  const list = (await waitFor(2)) as { result?: { tools?: { name: string }[] } };
  const names = (list.result?.tools ?? []).map((t) => t.name);
  if (names.length !== 43) fail(`expected 43 tools, got ${names.length}`);
  send({
    jsonrpc: '2.0',
    id: 3,
    method: 'tools/call',
    params: { name: 'list_sessions', arguments: {} },
  });
  const call = (await waitFor(3)) as { result?: { isError?: boolean } };
  if (call.result?.isError) fail(`list_sessions errored: ${JSON.stringify(call)}`);
  stdio.kill('SIGTERM');

  // http: serve on a random port → /health ready → SIGTERM exits 0
  // `--port 0` is programmatic-only (spec 08 §2.1): ask the OS for a free port and pass it to the CLI.
  const probe = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('') });
  const port = String(probe.port);
  probe.stop(true);
  const http = spawn(bin, ['serve', '--port', port, '--dataDir', dataDir, '--logFormat', 'json'], {
    cwd: dir,
  });
  let logs = '';
  http.stderr.on('data', (d) => {
    logs += String(d);
  });
  http.stdout.on('data', (d) => {
    logs += String(d);
  });
  const url = `http://127.0.0.1:${port}`;
  await new Promise<void>((resolve, reject) => {
    const started = Date.now();
    const tick = (): void => {
      fetch(`${url}/health`)
        .then((r) => {
          if (r.ok) resolve();
          else throw new Error(`status ${r.status}`);
        })
        .catch(() => {
          if (Date.now() - started > 30_000)
            reject(new Error(`server did not become ready\n${logs}`));
          else setTimeout(tick, 200);
        });
    };
    tick();
  });
  const health = await fetch(`${url}/health`).then((r) => r.json() as Promise<{ status?: string }>);
  if (health.status !== 'ready') fail(`health: ${JSON.stringify(health)}`);
  const exit = new Promise<number | null>((resolve) => http.on('exit', (code) => resolve(code)));
  http.kill('SIGTERM');
  const code = await Promise.race([
    exit,
    new Promise<number>((r) => setTimeout(() => r(-1), 20_000)),
  ]);
  if (code !== 0) fail(`SIGTERM exit code ${code}\n${logs}`);
  console.log('smoke-installed: ok');
} finally {
  rmSync(dir, { recursive: true, force: true });
}
