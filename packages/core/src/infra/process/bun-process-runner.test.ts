/** @module infra/process/bun-process-runner.test — real child processes: capture, stdin/EPIPE, timeout, abort, not-found, fake bw on PATH */

import { describe, expect, it } from 'bun:test';
import { FAKE_BW_DIR, FAKE_BW_TOKEN, fakeBwEnv } from '../../../test/helpers/fake-bw/index.ts';
import { ProcessSpawnError } from '../../ports/process-runner.ts';
import { createBunProcessRunner } from './bun-process-runner.ts';

const runner = createBunProcessRunner();
const BUN = process.execPath;

describe('createBunProcessRunner', () => {
  it('captures stdout, stderr and the exit code', async () => {
    const r = await runner.run(
      BUN,
      ['-e', 'console.log("out"); console.error("err"); process.exit(3)'],
      {
        env: { PATH: '/usr/bin' },
        timeoutMs: 10_000,
      },
    );
    expect(r).toEqual({ code: 3, stdout: 'out\n', stderr: 'err\n', timedOut: false });
  });

  it('writes stdin and passes only the given env', async () => {
    const r = await runner.run(
      BUN,
      [
        '-e',
        'process.stdin.on("data", (d) => process.stdout.write(String(d) + "|" + Object.keys(process.env).filter((k) => k === "ONLY").join()))',
      ],
      { env: { ONLY: '1' }, timeoutMs: 10_000, stdin: 'hello' },
    );
    expect(r.stdout).toBe('hello|ONLY');
  });

  it('tolerates a child that exits before reading stdin (EPIPE)', async () => {
    const r = await runner.run(BUN, ['-e', 'process.exit(0)'], {
      env: {},
      timeoutMs: 10_000,
      stdin: 'x'.repeat(1024 * 1024),
    });
    expect(r.code).toBe(0);
  });

  it('kills the child and reports timedOut when the deadline elapses', async () => {
    const r = await runner.run(BUN, ['-e', 'setTimeout(() => {}, 60_000)'], {
      env: {},
      timeoutMs: 200,
    });
    expect(r.timedOut).toBe(true);
    expect(r.code).toBeNull();
  });

  it('aborting the signal kills the child', async () => {
    const controller = new AbortController();
    const pending = runner.run(BUN, ['-e', 'setTimeout(() => {}, 60_000)'], {
      env: {},
      timeoutMs: 60_000,
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 100);
    const r = await pending;
    expect(r.code).toBeNull();
    expect(r.timedOut).toBe(false);
  });

  it('a missing binary rejects with ProcessSpawnError not_found', async () => {
    const err = await runner
      .run('/definitely/not/here/bw', [], { env: {}, timeoutMs: 1000 })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProcessSpawnError);
    expect((err as ProcessSpawnError).kind).toBe('not_found');
  });

  it('runs the fake bw from PATH with a minimal env', async () => {
    const env = fakeBwEnv({ session: FAKE_BW_TOKEN, basePath: `${process.env['PATH'] ?? ''}` });
    const r = await runner.run('bw', ['--nointeraction', 'status'], { env, timeoutMs: 20_000 });
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual({ status: 'unlocked' });
    expect(env['PATH']?.startsWith(FAKE_BW_DIR)).toBe(true);
  });
});
