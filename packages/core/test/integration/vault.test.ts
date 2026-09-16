/// <reference lib="dom" />
/** @module test/integration/vault — a real vault_fill: fake `bw` on PATH → BitwardenBackend → VaultBroker → real Chromium page; credential typed, trace chunk excluded, audit written. */

import { describe, expect, it } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { unzipSync } from 'fflate';
import { OperatorRequestBroker } from '../../src/domain/operator-requests/broker.ts';
import { VaultBroker } from '../../src/domain/vault/broker.ts';
import { VaultRedaction } from '../../src/domain/vault/redaction.ts';
import type { VaultPage } from '../../src/domain/vault/types.ts';
import { createSystemClock } from '../../src/infra/clock/system-clock.ts';
import { createNanoidIdGenerator } from '../../src/infra/ids/nanoid-id-generator.ts';
import { createCollectingLogger } from '../../src/infra/logging/collecting-logger.ts';
import { createBunProcessRunner } from '../../src/infra/process/bun-process-runner.ts';
import { BitwardenBackend } from '../../src/infra/vault-backends/bitwarden/bitwarden-backend.ts';
import { SecretRegistry } from '../../src/kernel/redact.ts';
import { secret } from '../../src/kernel/secret.ts';
import type { HostEnvironment } from '../../src/ports/host-environment.ts';
import {
  FAKE_BW_FIXTURE,
  FAKE_BW_TOKEN,
  fakeBwEnv,
  writeFakeBwConfig,
} from '../helpers/fake-bw/index.ts';
import { createVaultRepos } from '../helpers/in-memory-vault-repos.ts';
import { RecordingEventBus } from '../helpers/recording-event-bus.ts';
import { HOST, type LaunchedSession, useDriverFixtures } from './driver-fixture.ts';

function hostEnv(env: Record<string, string>): HostEnvironment {
  return {
    platform: HOST.platform,
    arch: HOST.arch,
    release: HOST.release,
    homeDir: '/tmp',
    tmpDir: '/tmp',
    totalMemoryBytes: 0,
    cpuCount: 1,
    isTty: { stdout: false, stderr: false },
    env,
  };
}

/** Adapts the Playwright page to the broker's `VaultPage` (callbacks are passed straight through). */
function vaultPage(session: LaunchedSession): VaultPage {
  const page = session.page;
  return {
    url: () => page.url(),
    fill: (selector, value, options) => page.fill(selector, value, options),
    click: (selector, options) => page.click(selector, options),
    waitForTimeout: (ms) => page.waitForTimeout(ms),
    $eval: (selector, fn) => page.$eval(selector, fn),
  };
}

/** Every text inside a trace zip (the D-13 invariant is asserted over all of it). */
async function traceText(path: string): Promise<string> {
  const files = unzipSync(new Uint8Array(await readFile(path)));
  return Object.values(files)
    .map((bytes) => new TextDecoder('utf8', { fatal: false }).decode(bytes))
    .join('\n');
}

describe('vault_fill end to end (fake bw + real Chromium)', () => {
  const { state } = useDriverFixtures();

  async function stack(dataDir: string, logPath: string) {
    await writeFakeBwConfig(dataDir, { log: logPath });
    const clock = createSystemClock();
    const ids = createNanoidIdGenerator({ clock });
    const logger = createCollectingLogger({ level: 'trace' });
    const registry = new SecretRegistry({ now: () => clock.now() });
    const repos = createVaultRepos();
    const events = new RecordingEventBus<Record<string, unknown>>();
    const env = fakeBwEnv({ home: dataDir, basePath: process.env['PATH'] ?? '' });
    const backend = new BitwardenBackend({
      runner: createBunProcessRunner(),
      host: hostEnv(env),
      clock,
      logger,
      timeoutMs: 30_000,
    });
    const confirm = new OperatorRequestBroker({
      requests: repos.requests,
      actions: repos.actions,
      leases: { pause: () => undefined, resume: () => undefined },
      events,
      clock,
      ids,
      logger,
    });
    const broker = new VaultBroker({
      backend,
      bindings: repos.bindings,
      policies: repos.policies,
      audit: repos.audit,
      redaction: new VaultRedaction({ registry, now: () => clock.now() }),
      events,
      clock,
      ids,
      logger,
      allowEvaluate: true,
      confirm,
    });
    return { clock, logger, registry, repos, backend, broker, dataDir };
  }

  it('unlocks through the fake bw, fills the fixture form, submits, and keeps the credential out of the trace', async () => {
    process.env['BROWSERHIVE_VAULT_CANARY'] = 'leak-me';
    const session = await state.launch({ slug: 'vault', tracing: true });
    const logPath = join(state.dataDir, 'fake-bw.log');
    const s = await stack(state.dataDir, logPath);

    // Unlock with a pasted session token; it reaches bw only through BW_SESSION, never argv.
    expect((await s.backend.status()).unlocked).toBe(false);
    await s.backend.unlock({ mode: 'token', token: secret(`${FAKE_BW_TOKEN}\n`) });
    expect((await s.backend.status()).unlocked).toBe(true);

    // Bind the fixture item to the fixture origin (IP literal → exact host match).
    const origin = new URL(state.fixture.origin).hostname;
    await s.repos.bindings.upsert({
      handle: 'work.fixture-login',
      tenantId: null,
      title: 'Fixture',
      itemName: FAKE_BW_FIXTURE.itemName,
      itemId: FAKE_BW_FIXTURE.itemId,
      groupId: FAKE_BW_FIXTURE.groupId,
      allowedOrigins: [origin],
      authorizedPrincipals: [],
      authorizedSessionSlugs: ['vault'],
      allowAllSessions: false,
      redactUsername: true,
      requireNoEvaluate: false,
      dashboardConfirm: false,
      version: 1,
      createdAt: s.clock.now(),
      updatedAt: s.clock.now(),
    });

    await session.page.goto(state.fixture.url('/form'));
    const result = await s.broker.fill(
      {
        entryName: 'work.fixture-login',
        usernameSelector: '#username',
        passwordSelector: '#password',
        submitSelector: '#submit',
        afterSubmitWaitMs: 200,
      },
      {
        session: {
          sessionId: session.handle.sessionId,
          slug: 'vault',
          disableEvaluate: false,
          vaultEnabled: true,
        },
        page: vaultPage(session),
        tracing: session.handle.tracing,
        principal: 'local',
        toolEventId: 'e-00000000000000000000000001',
      },
    );
    expect(result).toEqual({ status: 'success', redacted: true });

    // The site received the credential (the page is trusted; the agent is not).
    await session.page.waitForURL(/\/submitted$/);
    const body = await session.page.locator('#body').textContent();
    expect(body).toContain(encodeURIComponent(FAKE_BW_FIXTURE.password));

    // One audit row, secret-free, with the resolved item name and pass origin check.
    expect(s.repos.audit.rows).toHaveLength(1);
    expect(s.repos.audit.rows[0]).toMatchObject({
      entryName: FAKE_BW_FIXTURE.itemName,
      handle: 'work.fixture-login',
      result: 'success',
      originCheck: 'pass',
      principalId: 'local',
    });
    const everything = JSON.stringify([s.repos.audit.rows, s.logger.records, result]);
    expect(everything).not.toContain(FAKE_BW_FIXTURE.password);
    expect(everything).not.toContain(FAKE_BW_TOKEN);

    // The fake bw saw `--` before the positional and only the minimal env.
    const invocations = (await readFile(logPath, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { argv: string[]; env_keys: string[] });
    expect(invocations.some((i) => i.argv.includes('unlock'))).toBe(false);
    const get = invocations.find((i) => i.argv.includes('get'));
    expect(get?.argv).toEqual(['--nointeraction', 'get', 'item', '--', FAKE_BW_FIXTURE.itemId]);
    // A canary from this process must never reach the child; the three allowed keys must.
    for (const i of invocations) {
      expect(i.env_keys).not.toContain('BROWSERHIVE_VAULT_CANARY');
      expect(i.env_keys).toContain('PATH');
      expect(i.env_keys).toContain('HOME');
    }
    expect(get?.env_keys).toContain('BW_SESSION');

    // D-13: the concatenated trace.zip contains no credential string. NOTE: Playwright's chunk API
    // (`stopChunk`/`startChunk`) keeps the HAR tracer running across the pause, so the form POST
    // (with decoded urlencoded params) lands in the resumed chunk's `*.network`; a full
    // `tracing.stop()`/`tracing.start()` around the fill does not leak (verified experimentally).
    // `infra/browsers/tracing.ts` must pause/resume with stop/start for this assertion to hold.
    const tracePath = join(state.dataDir, 'trace.zip');
    const tracing = session.handle.tracing;
    expect(tracing).not.toBeNull();
    if (tracing === null) return;
    await tracing.stop(tracePath);
    const text = await traceText(tracePath);
    expect(text.length).toBeGreaterThan(0);
    expect(text).not.toContain(FAKE_BW_FIXTURE.password);
    expect(text).not.toContain(FAKE_BW_FIXTURE.username);
  }, 60_000);

  it('a locked backend audits and throws VAULT_LOCKED; an off-origin page is origin_mismatch', async () => {
    const session = await state.launch({ slug: 'vault' });
    const s = await stack(state.dataDir, join(state.dataDir, 'fake-bw-2.log'));
    await s.repos.bindings.upsert({
      handle: 'work.fixture-login',
      tenantId: null,
      title: 'Fixture',
      itemName: FAKE_BW_FIXTURE.itemName,
      itemId: FAKE_BW_FIXTURE.itemId,
      groupId: FAKE_BW_FIXTURE.groupId,
      allowedOrigins: ['example.invalid'],
      authorizedPrincipals: [],
      authorizedSessionSlugs: ['*'],
      allowAllSessions: false,
      redactUsername: false,
      requireNoEvaluate: false,
      dashboardConfirm: false,
      version: 1,
      createdAt: s.clock.now(),
      updatedAt: s.clock.now(),
    });
    await session.page.goto(state.fixture.url('/form'));
    const ctx = {
      session: {
        sessionId: session.handle.sessionId,
        slug: 'vault',
        disableEvaluate: false,
        vaultEnabled: true,
      },
      page: vaultPage(session),
      tracing: session.handle.tracing,
      principal: 'local',
    };
    const request = {
      entryName: 'work.fixture-login',
      usernameSelector: '#username',
      passwordSelector: '#password',
    };
    expect((await s.broker.fill(request, ctx)).status).toBe('origin_mismatch');

    const origin = new URL(state.fixture.origin).hostname;
    const stored = await s.repos.bindings.get('work.fixture-login');
    if (stored === null) throw new Error('binding vanished');
    await s.repos.bindings.upsert({ ...stored, allowedOrigins: [origin] });
    await expect(s.broker.fill(request, ctx)).rejects.toMatchObject({ code: 'VAULT_LOCKED' });
    expect(s.repos.audit.rows.map((r) => r.reason)).toEqual(['origin_mismatch', 'vault_locked']);
    expect(await session.page.inputValue('#password')).toBe('');
  }, 60_000);
});
