/** @module infra/vault-backends/bitwarden/bitwarden-backend.test — bw adapter against a fake ProcessRunner: arg shape, minimal env, timeout, error mapping, secrets */

import { describe, expect, it } from 'bun:test';
import { FakeClock } from '../../../../test/helpers/fake-clock.ts';
import { secret } from '../../../kernel/secret.ts';
import type { HostEnvironment } from '../../../ports/host-environment.ts';
import {
  type ProcessRunner,
  type ProcessRunOptions,
  type ProcessRunResult,
  ProcessSpawnError,
} from '../../../ports/process-runner.ts';
import { createCollectingLogger } from '../../logging/collecting-logger.ts';
import { BitwardenBackend } from './bitwarden-backend.ts';

interface Call {
  readonly command: string;
  readonly args: readonly string[];
  readonly options: ProcessRunOptions;
}

/** A `ProcessRunner` driven by a handler over `(args, env)`. */
function fakeRunner(
  handler: (
    args: readonly string[],
    env: Readonly<Record<string, string>>,
  ) => Partial<ProcessRunResult> | Error,
): { runner: ProcessRunner; calls: Call[] } {
  const calls: Call[] = [];
  return {
    calls,
    runner: {
      run(command, args, options) {
        calls.push({ command, args, options });
        const r = handler(args, options.env);
        if (r instanceof Error) return Promise.reject(r);
        return Promise.resolve({
          code: r.code ?? 0,
          stdout: r.stdout ?? '',
          stderr: r.stderr ?? '',
          timedOut: r.timedOut ?? false,
        });
      },
    },
  };
}

function host(env: Record<string, string> = {}): HostEnvironment {
  return {
    platform: 'linux',
    arch: 'x64',
    release: '6.0',
    homeDir: '/home/tester',
    tmpDir: '/tmp',
    totalMemoryBytes: 0,
    cpuCount: 1,
    isTty: { stdout: false, stderr: false },
    env: { PATH: '/usr/bin', SECRET_VAR: 'leak-me', ...env },
  };
}

function make(runner: ProcessRunner, env: Record<string, string> = {}): BitwardenBackend {
  return new BitwardenBackend({
    runner,
    host: host(env),
    clock: new FakeClock(0),
    logger: createCollectingLogger({ level: 'trace' }),
    timeoutMs: 1234,
  });
}

/** The subcommand words after the global `--nointeraction`. */
const words = (c: Call): readonly string[] => c.args.filter((a) => a !== '--nointeraction');

describe('BitwardenBackend — child invocation shape', () => {
  it('passes a minimal env (PATH, HOME, BW_SESSION), the per-call timeout, and `--` before positionals', async () => {
    const { runner, calls } = fakeRunner((args) =>
      args.includes('get')
        ? {
            stdout: JSON.stringify({
              id: 'guid-1',
              name: 'x',
              login: { username: 'u', password: 'p' },
            }),
          }
        : {},
    );
    const bw = make(runner, { BW_SESSION: 'tok', HOME: '/home/other' });
    await bw.getEntry({ id: 'guid-1', name: 'ignored' });
    const call = calls[0];
    expect(call?.command).toBe('bw');
    expect(call?.args[0]).toBe('--nointeraction');
    expect(words(call as Call)).toEqual(['get', 'item', '--', 'guid-1']);
    expect(call?.options.env).toEqual({ PATH: '/usr/bin', HOME: '/home/other', BW_SESSION: 'tok' });
    expect(call?.options.timeoutMs).toBe(1234);
    expect(call?.options.stdin).toBeUndefined();
  });

  it('a dangerous item name cannot become an option thanks to `--`', async () => {
    const { runner, calls } = fakeRunner(() => ({
      stdout: JSON.stringify({ login: { password: 'p' } }),
    }));
    await make(runner, { BW_SESSION: 'tok' }).getEntry({ name: '--session=evil' });
    expect(words(calls[0] as Call)).toEqual(['get', 'item', '--', '--session=evil']);
  });

  it('falls back to HOME from the host when the env has none', async () => {
    const { runner, calls } = fakeRunner(() => ({
      stdout: JSON.stringify({ status: 'unlocked' }),
    }));
    await make(runner, { BW_SESSION: 'tok' }).status();
    expect(calls[0]?.options.env['HOME']).toBe('/home/tester');
  });
});

describe('BitwardenBackend — unlock and status', () => {
  it('a pasted token (whitespace trimmed) is verified with bw status, never bw unlock', async () => {
    const { runner, calls } = fakeRunner((args, env) =>
      args.includes('status') && env['BW_SESSION'] === 'SESSION-KEY-123'
        ? { stdout: JSON.stringify({ status: 'unlocked' }) }
        : { stdout: JSON.stringify({ status: 'locked' }) },
    );
    const bw = make(runner);
    expect(bw.capabilities.unlock).toBe('token');
    expect((await bw.status()).unlocked).toBe(false);
    expect(calls).toHaveLength(0);
    await bw.unlock({ mode: 'token', token: secret('  SESSION-KEY-123\n') });
    expect(words(calls[0] as Call)).toEqual(['status']);
    expect(calls[0]?.args).not.toContain('SESSION-KEY-123');
    expect(calls.some((c) => c.args.includes('unlock'))).toBe(false);
    const status = await bw.status();
    expect(status).toEqual({
      unlocked: true,
      unlock: { required: false, mode: 'token', hint: bw.unlockHint },
      checkedAt: 0,
    });
    expect(calls[1]?.options.env['BW_SESSION']).toBe('SESSION-KEY-123');
  });

  it('a passphrase is refused without shelling out and without logging it', async () => {
    const logger = createCollectingLogger({ level: 'trace' });
    const { runner, calls } = fakeRunner(() => ({}));
    const bw = new BitwardenBackend({ runner, host: host(), clock: new FakeClock(0), logger });
    await expect(
      bw.unlock({ mode: 'passphrase', passphrase: secret('my-master-pw') }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    expect(calls).toHaveLength(0);
    expect(JSON.stringify(logger.records)).not.toContain('my-master-pw');
  });

  it('a blank token is VAULT_UNLOCK_FAILED without shelling out', async () => {
    const { runner, calls } = fakeRunner(() => ({}));
    await expect(
      make(runner).unlock({ mode: 'token', token: secret(' \n') }),
    ).rejects.toMatchObject({ code: 'VAULT_UNLOCK_FAILED', details: { mode: 'token' } });
    expect(calls).toHaveLength(0);
  });

  it('token unlock adopts the token only when status confirms it', async () => {
    const { runner, calls } = fakeRunner(() => ({ stdout: JSON.stringify({ status: 'locked' }) }));
    const bw = make(runner);
    await expect(bw.unlock({ mode: 'token', token: secret('bad') })).rejects.toMatchObject({
      code: 'VAULT_UNLOCK_FAILED',
      details: { mode: 'token' },
    });
    expect(calls[0]?.options.env['BW_SESSION']).toBe('bad');
    await expect(bw.listGroups()).rejects.toMatchObject({ code: 'VAULT_LOCKED' });
    const ok = fakeRunner(() => ({ stdout: JSON.stringify({ status: 'unlocked' }) }));
    const bw2 = make(ok.runner);
    await bw2.unlock({ mode: 'token', token: secret('good') });
    bw2.lock();
    expect((await bw2.status()).unlocked).toBe(false);
  });

  it('operations without a session are VAULT_LOCKED without shelling out', async () => {
    const { runner, calls } = fakeRunner(() => ({}));
    const bw = make(runner);
    for (const op of [
      () => bw.listEntries({}),
      () => bw.listGroups(),
      () => bw.getEntry({ id: 'x' }),
      () => bw.sync(),
    ]) {
      await expect(op()).rejects.toMatchObject({
        code: 'VAULT_LOCKED',
        details: { backend: 'bitwarden' },
      });
    }
    expect(calls).toHaveLength(0);
  });
});

describe('BitwardenBackend — items, groups, sync', () => {
  it('listEntries maps id/name/group/uris and passes --folderid/--search', async () => {
    const { runner, calls } = fakeRunner(() => ({
      stdout: JSON.stringify([
        { id: 'i1', name: 'a', login: { uris: [{ uri: 'https://a' }, null, { uri: 7 }] } },
        { id: 'i2', name: 'b', folderId: 'f1' },
        { id: 'i3', name: 'c', folderId: '' },
        { id: 'i4', notName: true },
      ]),
    }));
    const bw = make(runner, { BW_SESSION: 'tok' });
    expect(await bw.listEntries({ groupId: 'f1', search: 'a' })).toEqual([
      { id: 'i1', name: 'a', groupId: null, uris: ['https://a'] },
      { id: 'i2', name: 'b', groupId: 'f1', uris: [] },
      { id: 'i3', name: 'c', groupId: null, uris: [] },
    ]);
    expect(words(calls[0] as Call)).toEqual(['list', 'items', '--folderid', 'f1', '--search', 'a']);
    await bw.listEntries({ groupId: null });
    expect(words(calls[1] as Call)).toEqual(['list', 'items', '--folderid', 'null']);
  });

  it('listGroups normalises the No Folder id and synthesises it when absent', async () => {
    const withNull = fakeRunner(() => ({
      stdout: JSON.stringify([
        { id: '', name: 'No Folder' },
        { id: 'f1', name: 'Work' },
        { id: null, name: 'dup' },
      ]),
    }));
    expect(await make(withNull.runner, { BW_SESSION: 'tok' }).listGroups()).toEqual([
      { id: null, name: 'No Folder' },
      { id: 'f1', name: 'Work' },
    ]);
    const without = fakeRunner(() => ({ stdout: JSON.stringify([{ id: 'f1', name: 'Work' }]) }));
    expect(await make(without.runner, { BW_SESSION: 'tok' }).listGroups()).toEqual([
      { id: 'f1', name: 'Work' },
      { id: null, name: 'No Folder' },
    ]);
  });

  it('getEntry wraps the password (and totp) in Secret and maps not-found / locked / passwordless', async () => {
    const ok = fakeRunner(() => ({
      stdout: JSON.stringify({
        id: 'g',
        name: 'n',
        folderId: 'f',
        login: { username: 'alice', password: 's3cr3t', totp: 'otp', uris: [{ uri: 'https://a' }] },
      }),
    }));
    const entry = await make(ok.runner, { BW_SESSION: 'tok' }).getEntry({ id: 'g' });
    expect(entry).toMatchObject({
      id: 'g',
      name: 'n',
      groupId: 'f',
      username: 'alice',
      uris: ['https://a'],
    });
    expect(entry.password.reveal()).toBe('s3cr3t');
    expect(entry.totp?.reveal()).toBe('otp');
    expect(JSON.stringify(entry)).not.toContain('s3cr3t');
    expect(String(entry.password)).toBe('[secret]');

    const notFound = fakeRunner(() => ({ stderr: 'Not found.', code: 1 }));
    await expect(
      make(notFound.runner, { BW_SESSION: 'tok' }).getEntry({ name: 'nope' }),
    ).rejects.toMatchObject({ code: 'VAULT_ENTRY_NOT_FOUND', details: { entry_name: 'nope' } });
    const locked = fakeRunner(() => ({ stderr: 'Vault is locked.', code: 1 }));
    await expect(
      make(locked.runner, { BW_SESSION: 'tok' }).getEntry({ id: 'x' }),
    ).rejects.toMatchObject({ code: 'VAULT_LOCKED' });
    const passwordless = fakeRunner(() => ({
      stdout: JSON.stringify({ login: { username: 'u' } }),
    }));
    await expect(
      make(passwordless.runner, { BW_SESSION: 'tok' }).getEntry({ id: 'x' }),
    ).rejects.toMatchObject({ code: 'VAULT_ENTRY_NOT_FOUND' });
  });

  it('sync runs `bw sync` then re-enumerates', async () => {
    const seen: string[][] = [];
    const { runner } = fakeRunner((args) => {
      seen.push([...args]);
      if (args.includes('sync')) return { stdout: 'Syncing complete.' };
      if (args.includes('items'))
        return {
          stdout: JSON.stringify([
            { id: 'i1', name: 'GitHub' },
            { id: 'i2', name: 'GitLab' },
          ]),
        };
      if (args.includes('folders')) return { stdout: JSON.stringify([{ id: 'f1', name: 'Work' }]) };
      return { code: 1, stderr: 'unexpected' };
    });
    expect(await make(runner, { BW_SESSION: 'tok' }).sync()).toEqual({ items: 2, groups: 2 });
    expect(seen[0]).toEqual(['--nointeraction', 'sync']);
    const lockedSync = fakeRunner(() => ({ code: 1, stderr: 'Vault is locked.' }));
    await expect(make(lockedSync.runner, { BW_SESSION: 'tok' }).sync()).rejects.toMatchObject({
      code: 'VAULT_LOCKED',
    });
  });
});

describe('BitwardenBackend — failure mapping', () => {
  it('a missing binary is VAULT_BACKEND_ERROR not_installed with the spawn error as cause', async () => {
    const { runner } = fakeRunner(() => new ProcessSpawnError('not_found', 'bw'));
    const err = await make(runner, { BW_SESSION: 'tok' })
      .listGroups()
      .catch((e: unknown) => e);
    expect(err).toMatchObject({
      code: 'VAULT_BACKEND_ERROR',
      details: { backend: 'bitwarden', kind: 'not_installed' },
    });
    expect((err as { cause: unknown }).cause).toBeInstanceOf(ProcessSpawnError);
  });

  it('a timed-out child is VAULT_BACKEND_ERROR timeout', async () => {
    const { runner } = fakeRunner(() => ({ code: null, timedOut: true }));
    await expect(make(runner, { BW_SESSION: 'tok' }).listGroups()).rejects.toMatchObject({
      code: 'VAULT_BACKEND_ERROR',
      details: { kind: 'timeout' },
    });
  });

  it('a non-zero exit and malformed JSON are VAULT_BACKEND_ERROR exit, never echoing stdout', async () => {
    const exit = fakeRunner(() => ({ code: 2, stderr: 'boom' }));
    await expect(make(exit.runner, { BW_SESSION: 'tok' }).listGroups()).rejects.toMatchObject({
      code: 'VAULT_BACKEND_ERROR',
      details: { kind: 'exit' },
    });
    const notJson = fakeRunner(() => ({ stdout: 'not json secret-ish' }));
    const err = await make(notJson.runner, { BW_SESSION: 'tok' })
      .listGroups()
      .catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'VAULT_BACKEND_ERROR', details: { kind: 'exit' } });
    expect(JSON.stringify(err)).not.toContain('secret-ish');
    const wrongShape = fakeRunner(() => ({ stdout: JSON.stringify({ status: 'weird' }) }));
    await expect(
      make(wrongShape.runner, { BW_SESSION: 'tok' }).unlock({ mode: 'token', token: secret('t') }),
    ).rejects.toMatchObject({ code: 'VAULT_UNLOCK_FAILED' });
  });

  it('status swallows backend failures as locked', async () => {
    const { runner } = fakeRunner(() => new ProcessSpawnError('not_found', 'bw'));
    expect((await make(runner, { BW_SESSION: 'tok' }).status()).unlocked).toBe(false);
  });
});
