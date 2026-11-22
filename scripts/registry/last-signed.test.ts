/** @module scripts/registry/last-signed.test — `registry-last-signed.mjs` (verification #99 N1, N4): only an artefact of this repository's own `website.yml` or `registry-resign.yml` run on `main` (push, schedule or dispatch, succeeded) counts, never a pull request's (a fork's `main` included), results are paged; the zip is unpacked as regular files only (no symlink, no `..`), and the command line against a fake GitHub API. */

import { afterAll, describe, expect, it } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { zipSync } from 'fflate';
import { findLastSigned, unzipRegular } from '../registry-last-signed.mjs';

const REPO = 'owner/project';
const SCRIPT = resolve(import.meta.dir, '..', 'registry-last-signed.mjs');
const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});
const temp = () => {
  const dir = mkdtempSync(join(tmpdir(), 'bh-last-signed-'));
  dirs.push(dir);
  return dir;
};

interface Run {
  id: number;
  event: string;
  path: string;
  head_branch: string;
  conclusion: string;
  head_repository: { full_name: string };
  repository: { full_name: string };
}

function run(id: number, extra: Partial<Run> = {}): Run {
  return {
    id,
    event: 'push',
    path: '.github/workflows/website.yml',
    head_branch: 'main',
    conclusion: 'success',
    head_repository: { full_name: REPO },
    repository: { full_name: REPO },
    ...extra,
  };
}

function artifact(id: number, runId: number, minutes: number, fork = false) {
  return {
    id,
    expired: false,
    created_at: new Date(Date.UTC(2026, 10, 22, 0, minutes)).toISOString(),
    workflow_run: {
      id: runId,
      head_branch: 'main',
      repository_id: 1,
      head_repository_id: fork ? 2 : 1,
    },
  };
}

function fakeApi(artifacts: ReturnType<typeof artifact>[], runs: Run[]) {
  const calls: string[] = [];
  const api = async (path: string) => {
    calls.push(path);
    const page = Number(/[?&]page=(\d+)/.exec(path)?.[1] ?? 1);
    if (path.includes('/actions/artifacts?'))
      return { artifacts: artifacts.slice((page - 1) * 100, page * 100) };
    const id = Number(/runs\/(\d+)/.exec(path)?.[1]);
    return runs.find((r) => r.id === id) ?? {};
  };
  return { api, calls };
}

describe('findLastSigned', () => {
  it('takes the newest artefact of a qualifying run, never a fork or a pull request', async () => {
    const { api } = fakeApi(
      [
        artifact(10, 100, 1),
        artifact(11, 101, 2, true), // a fork's `main`: other head repository
        artifact(12, 102, 3), // a pull request run
        artifact(13, 103, 4), // another workflow
        artifact(14, 104, 5), // failed
      ],
      [
        run(100),
        run(101),
        run(102, { event: 'pull_request' }),
        run(103, { path: '.github/workflows/evil.yml' }),
        run(104, { conclusion: 'failure' }),
      ],
    );
    expect((await findLastSigned(api, REPO))?.id).toBe(10);
  });

  it('accepts the weekly re-sign and pages through every artefact', async () => {
    const forks = Array.from({ length: 150 }, (_, i) =>
      artifact(1000 + i, 9000 + i, 100 + i, true),
    );
    const { api, calls } = fakeApi(
      [...forks, artifact(20, 200, 1)],
      [
        run(200, {
          event: 'schedule',
          path: '.github/workflows/registry-resign.yml@refs/heads/main',
        }),
      ],
    );
    expect((await findLastSigned(api, REPO))?.id).toBe(20);
    expect(calls.filter((c) => c.includes('artifacts?')).length).toBe(2);
  });

  it('finds none when no run qualifies', async () => {
    const { api } = fakeApi(
      [artifact(30, 300, 1)],
      [run(300, { head_repository: { full_name: 'fork/project' } })],
    );
    expect(await findLastSigned(api, REPO)).toBeNull();
  });
});

describe('unzipRegular', () => {
  const enc = new TextEncoder();

  it('writes the regular files of the archive', () => {
    const out = temp();
    const zip = zipSync({
      'index.json': enc.encode('{}\n'),
      packs: { 'a.com': { 'x.json': enc.encode('1') } },
    });
    expect(unzipRegular(zip, out).sort()).toEqual(['index.json', 'packs/a.com/x.json']);
    expect(readFileSync(join(out, 'packs', 'a.com', 'x.json'), 'utf8')).toBe('1');
  });

  it('refuses a symlink entry and unsafe names', () => {
    const symlink = zipSync({
      'keys.json': [enc.encode('/etc/hostname'), { os: 3, attrs: (0o120777 << 16) >>> 0 }],
    });
    expect(() => unzipRegular(symlink, temp())).toThrow('not a regular file');
    expect(() => unzipRegular(zipSync({ '../escape.json': enc.encode('x') }), temp())).toThrow(
      'unsafe name',
    );
    expect(() => unzipRegular(enc.encode('not a zip'), temp())).toThrow('not a zip');
  });
});

describe('registry-last-signed.mjs against a fake GitHub API', () => {
  it('downloads and unpacks the qualifying artefact', async () => {
    const zip = zipSync({ 'index.json': new TextEncoder().encode('{"version":7}\n') });
    const server = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      fetch(request) {
        const url = new URL(request.url);
        if (url.pathname.endsWith('/actions/artifacts')) {
          return Response.json({ artifacts: [artifact(5, 50, 1, true), artifact(6, 60, 0)] });
        }
        if (url.pathname.endsWith('/runs/60')) return Response.json(run(60));
        if (url.pathname.endsWith('/runs/50')) return Response.json(run(50));
        if (url.pathname.endsWith('/artifacts/6/zip')) return new Response(zip);
        return new Response('no', { status: 404 });
      },
    });
    try {
      const out = join(temp(), 'last');
      // Asynchronous: a synchronous spawn would block this process's fake server.
      const child = Bun.spawn(
        [
          process.env['BHDEV_NODE'] ?? 'node',
          SCRIPT,
          '--out',
          out,
          '--repo',
          REPO,
          '--api',
          `http://127.0.0.1:${server.port}`,
        ],
        { env: { ...process.env, GH_TOKEN: 'test' }, stdout: 'pipe', stderr: 'pipe' },
      );
      const stdout = await new Response(child.stdout).text();
      await child.exited;
      const result = { stdout };
      expect(result.stdout).toContain('artefact 6 of run 60');
      expect(readFileSync(join(out, 'index.json'), 'utf8')).toContain('"version":7');
      expect(existsSync(join(out, 'keys.json'))).toBe(false);
    } finally {
      server.stop(true);
    }
  }, 30_000);
});
