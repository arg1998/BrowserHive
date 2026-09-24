/** @module infra/browsers/sandbox-policy.test — the fallback matrix at launch time: `off` as before, `auto` probes once per executable and never fails a launch, `on`/agent requests fail fast and typed. */

import { describe, expect, it } from 'bun:test';
import type { SandboxMode } from '@browserhive/contracts/enums';
import { FakeClock } from '../../../test/helpers/fake-clock.ts';
import { createCollectingLogger } from '../../../test/helpers/test-logger.ts';
import { AppError } from '../../kernel/errors/app-error.ts';
import { SandboxPolicy, type SandboxTarget } from './sandbox-policy.ts';

const NO_SANDBOX = new Error(
  'Chromium sandboxing failed!\n  - [err] [1:1:0/0:FATAL:zygote_host_impl_linux.cc:129] No usable sandbox! If you are running on Ubuntu 23.10+',
);
const BUNDLED: SandboxTarget = {
  channel: 'chromium',
  executablePath: '/cache/chromium-1243/chrome',
};
const CHROME: SandboxTarget = { channel: 'chrome', executablePath: '/opt/google/chrome/chrome' };

function policy(mode: SandboxMode, root = false) {
  const logger = createCollectingLogger();
  const made: { channel: string; requiredBy: string; working: readonly string[] }[] = [];
  const p = new SandboxPolicy({
    mode,
    root,
    logger,
    clock: new FakeClock(),
    unavailable: ({ target, reason, requiredBy, workingChannels }) => {
      made.push({ channel: target.channel, requiredBy, working: workingChannels });
      return new AppError(
        'SANDBOX_UNAVAILABLE',
        {
          channel: target.channel,
          reason,
          required_by: requiredBy,
          alternatives: [...workingChannels],
          guidance: [],
        },
        { publicMessage: reason },
      );
    },
  });
  return { p, logger, made };
}

/** A browser that can or cannot sandbox; records every attempt. */
function browser(canSandbox: boolean, other: Error | null = null) {
  const attempts: boolean[] = [];
  return {
    attempts,
    attempt: async (sandbox: boolean) => {
      attempts.push(sandbox);
      await Promise.resolve();
      if (other !== null) throw other;
      if (sandbox && !canSandbox) throw NO_SANDBOX;
      return `browser(${sandbox ? 'sandboxed' : 'unsandboxed'})`;
    },
  };
}

describe('sandbox=off', () => {
  it('launches exactly as before: never with the sandbox', async () => {
    const { p } = policy('off');
    const b = browser(true);
    expect(await p.launch(BUNDLED, false, b.attempt)).toEqual({
      value: 'browser(unsandboxed)',
      sandboxed: false,
    });
    expect(b.attempts).toEqual([false]);
    expect(p.entries()).toEqual([]);
  });

  it("an agent's chromiumSandbox: true is honoured, and a host that cannot sandbox fails typed", async () => {
    const { p, made } = policy('off');
    expect((await p.launch(BUNDLED, true, browser(true).attempt)).sandboxed).toBe(true);
    const blocked = browser(false);
    const err = await p.launch(CHROME, true, blocked.attempt).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'SANDBOX_UNAVAILABLE', retryable: 'never' });
    expect(made).toEqual([
      { channel: 'chrome', requiredBy: 'launch_options', working: ['chromium'] },
    ]);
    expect(blocked.attempts).toEqual([true]);
  });
});

describe('sandbox=auto', () => {
  it('falls back once, warns once, and later launches skip the failed attempt', async () => {
    const { p, logger } = policy('auto');
    const b = browser(false);
    expect(await p.launch(BUNDLED, false, b.attempt)).toEqual({
      value: 'browser(unsandboxed)',
      sandboxed: false,
    });
    expect(await p.launch(BUNDLED, false, b.attempt)).toEqual({
      value: 'browser(unsandboxed)',
      sandboxed: false,
    });
    expect(b.attempts).toEqual([true, false, false]);
    const warns = logger.records.filter((r) => r.level === 'warn');
    expect(warns.map((r) => r.msg)).toEqual(['sandbox fell back']);
    expect(warns[0]?.fields).toMatchObject({ channel: 'chromium', reason: 'No usable sandbox!' });
    expect(p.verdict(BUNDLED)).toMatchObject({
      state: 'unavailable',
      reason: 'No usable sandbox!',
    });
  });

  it('a browser that sandboxes stays sandboxed', async () => {
    const { p } = policy('auto');
    const b = browser(true);
    expect((await p.launch(CHROME, false, b.attempt)).sandboxed).toBe(true);
    expect((await p.launch(CHROME, false, b.attempt)).sandboxed).toBe(true);
    expect(b.attempts).toEqual([true, true]);
    expect(p.workingChannels()).toEqual(['chrome']);
  });

  it('concurrent first launches wait for one probe instead of all failing first', async () => {
    const { p } = policy('auto');
    const b = browser(false);
    const results = await Promise.all([
      p.launch(BUNDLED, false, b.attempt),
      p.launch(BUNDLED, false, b.attempt),
      p.launch(BUNDLED, false, b.attempt),
    ]);
    expect(results.every((r) => !r.sandboxed)).toBe(true);
    expect(b.attempts.filter((a) => a)).toEqual([true]);
  });

  it('verdicts are per executable: one blocked browser does not unsandbox another', async () => {
    const { p } = policy('auto');
    await p.launch(BUNDLED, false, browser(false).attempt);
    expect((await p.launch(CHROME, false, browser(true).attempt)).sandboxed).toBe(true);
  });

  it('an unrecognised failure is blamed on the sandbox only because the browser starts without it', async () => {
    const { p, logger } = policy('auto');
    const edge: SandboxTarget = { channel: 'edge', executablePath: '/opt/microsoft/msedge/msedge' };
    const attempts: boolean[] = [];
    const unrecognised = async (sandbox: boolean) => {
      attempts.push(sandbox);
      if (sandbox)
        throw new Error('browserType.launch: Browser closed.\n  - [err] Trace/breakpoint trap');
      return sandbox;
    };
    expect(await p.launch(edge, false, unrecognised)).toEqual({ value: false, sandboxed: false });
    expect(await p.launch(edge, false, unrecognised)).toEqual({ value: false, sandboxed: false });
    expect(attempts).toEqual([true, false, false]);
    expect(p.verdict(edge)?.state).toBe('unavailable');
    expect(logger.records.filter((r) => r.level === 'warn')).toHaveLength(1);
  });

  it('a required sandbox with an unrecognised failure is confirmed, closed, and fails typed', async () => {
    const { p } = policy('off');
    const edge: SandboxTarget = { channel: 'edge', executablePath: '/opt/microsoft/msedge/msedge' };
    const disposed: boolean[] = [];
    const unrecognised = async (sandbox: boolean) => {
      if (sandbox) throw new Error('browserType.launch: Browser closed.');
      return sandbox;
    };
    const err = await p
      .launch(edge, true, unrecognised, async (v) => {
        disposed.push(v);
      })
      .catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'SANDBOX_UNAVAILABLE', retryable: 'never' });
    expect(disposed).toEqual([false]);
    const broken = await p
      .launch(CHROME, true, async () => {
        throw new Error('crash');
      })
      .catch((e: unknown) => e);
    expect(broken).toBeInstanceOf(Error);
    expect((broken as Error).message).toBe('crash');
  });

  it('a browser that fails either way surfaces its own error (never swallowed)', async () => {
    const { p } = policy('auto');
    const broken = browser(true, new Error('crash'));
    await expect(p.launch(CHROME, false, broken.attempt)).rejects.toThrow('crash');
    expect(p.verdict(CHROME)).toBeUndefined();
  });

  it('typed errors (BROWSER_NOT_INSTALLED) pass through without a second launch', async () => {
    const { p } = policy('auto');
    const attempts: boolean[] = [];
    const missing = async (sandbox: boolean) => {
      attempts.push(sandbox);
      throw new AppError('BROWSER_NOT_INSTALLED', { channel: 'chrome', install_command: 'x' });
    };
    await expect(p.launch(CHROME, false, missing)).rejects.toMatchObject({
      code: 'BROWSER_NOT_INSTALLED',
    });
    expect(attempts).toEqual([true]);
  });

  it('as root the sandbox is never attempted', async () => {
    const { p } = policy('auto', true);
    const b = browser(true);
    expect((await p.launch(CHROME, false, b.attempt)).sandboxed).toBe(false);
    expect(b.attempts).toEqual([false]);
  });

  it("an agent's chromiumSandbox: true is a requirement, not a hint", async () => {
    const { p } = policy('auto');
    const err = await p.launch(BUNDLED, true, browser(false).attempt).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'SANDBOX_UNAVAILABLE' });
  });
});

describe('sandbox=on', () => {
  it('sandboxes a browser that can', async () => {
    const { p } = policy('on');
    const b = browser(true);
    expect((await p.launch(CHROME, false, b.attempt)).sandboxed).toBe(true);
  });

  it('fails typed, then fails immediately without launching again', async () => {
    const { p, made } = policy('on');
    p.record(CHROME, { state: 'works' });
    const b = browser(false);
    await expect(p.launch(BUNDLED, false, b.attempt)).rejects.toMatchObject({
      code: 'SANDBOX_UNAVAILABLE',
    });
    await expect(p.launch(BUNDLED, false, b.attempt)).rejects.toMatchObject({
      code: 'SANDBOX_UNAVAILABLE',
    });
    expect(b.attempts).toEqual([true]);
    expect(made.map((m) => m.working)).toEqual([['chrome'], ['chrome']]);
    expect(made[0]?.requiredBy).toBe('config');
  });
});
