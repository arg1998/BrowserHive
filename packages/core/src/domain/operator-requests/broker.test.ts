/** @module domain/operator-requests/broker.test — open/settle/timeout/cancel/session-close/orphan/idempotency/bounded-queue semantics */

import { beforeEach, describe, expect, it } from 'bun:test';
import { FakeClock } from '../../../test/helpers/fake-clock.ts';
import { FakeIdGenerator } from '../../../test/helpers/fake-id-generator.ts';
import { createVaultRepos } from '../../../test/helpers/in-memory-vault-repos.ts';
import { RecordingEventBus } from '../../../test/helpers/recording-event-bus.ts';
import { createCollectingLogger } from '../../../test/helpers/test-logger.ts';
import { OperatorRequestBroker } from './broker.ts';
import {
  CANCELLED_MESSAGE,
  RESTART_MESSAGE,
  SESSION_CLOSE_MESSAGE,
  TIMEOUT_MESSAGE,
} from './messages.ts';
import type { OperatorRequestEvents } from './types.ts';

function harness(limits?: { perSession?: number; global?: number }) {
  const clock = new FakeClock(1_000);
  const ids = new FakeIdGenerator();
  const repos = createVaultRepos();
  const events = new RecordingEventBus<OperatorRequestEvents>();
  const leases = {
    calls: [] as string[],
    pause(id: string, at: number) {
      leases.calls.push(`pause:${id}:${at}`);
    },
    resume(id: string, at: number) {
      leases.calls.push(`resume:${id}:${at}`);
    },
  };
  const broker = new OperatorRequestBroker({
    requests: repos.requests,
    actions: repos.actions,
    leases,
    events,
    clock,
    ids,
    logger: createCollectingLogger(),
    ...(limits !== undefined && { limits }),
  });
  return { clock, ids, repos, events, leases, broker };
}

const attention = (over: Record<string, unknown> = {}) => ({
  kind: 'attention' as const,
  sessionId: 'demo-00000001',
  owner: 'local',
  reason: 'solve captcha',
  mode: 'takeover' as const,
  ...over,
});

describe('OperatorRequestBroker — open', () => {
  let h: ReturnType<typeof harness>;
  beforeEach(() => {
    h = harness();
  });

  it('persists a pending row, pauses the lease, publishes attention.created', async () => {
    const handle = await h.broker.open(
      attention({ options: { choices: ['a', 'b'] }, timeoutMs: 60_000 }),
    );
    expect(handle.id).toMatch(/^a-\d{12}$/);
    expect(handle.timeoutMs).toBe(60_000);
    expect(handle.reused).toBe(false);
    const row = await h.repos.requests.get(handle.id);
    expect(row?.status).toBe('pending');
    expect(row?.reason).toBe('solve captcha');
    expect(row?.options).toEqual({ choices: ['a', 'b'] });
    expect(row?.deadlineAt).toBe(61_000);
    expect(h.leases.calls).toEqual(['pause:demo-00000001:1000']);
    expect(h.events.names()).toEqual(['attention.created']);
    expect(h.broker.hasOpen('demo-00000001')).toBe(true);
    expect(h.broker.hasOpen('demo-00000001', (r) => r.mode === 'notify')).toBe(false);
    expect(h.broker.openCount('attention')).toBe(1);
  });

  it('a vault_confirm request publishes vault.confirm.created / resolved', async () => {
    const handle = await h.broker.open({
      kind: 'vault_confirm',
      sessionId: 'demo-00000001',
      owner: 'local',
      reason: 'work.github',
      entryName: 'work.github',
      tool: 'vault_fill',
      toolEventId: 'e-00000000000000000000000001',
      pageUrl: 'https://github.com/login',
    });
    expect(handle.timeoutMs).toBeNull();
    const row = await h.repos.requests.get(handle.id);
    expect(row).toMatchObject({
      kind: 'vault_confirm',
      entryName: 'work.github',
      tool: 'vault_fill',
      pageUrl: 'https://github.com/login',
      toolEventId: 'e-00000000000000000000000001',
    });
    await h.broker.resolve(handle.id, { status: 'rejected', reason: 'phishy' }, 'admin');
    expect(h.events.names()).toEqual(['vault.confirm.created', 'vault.confirm.resolved']);
    expect((await handle.promise).resolutionReason).toBe('phishy');
  });

  it('wraps non-object options and never throws on unserializable ones', async () => {
    const a = await h.broker.open(attention({ options: 'text' }));
    expect((await h.repos.requests.get(a.id))?.options).toEqual({ value: 'text' });
    const cyclic: Record<string, unknown> = {};
    cyclic['self'] = cyclic;
    const b = await h.broker.open(attention({ options: cyclic }));
    expect((await h.repos.requests.get(b.id))?.options).toEqual({ value: '[unserializable]' });
  });

  it('idempotency: the same key within a session returns the same open request', async () => {
    const a = await h.broker.open(attention({ idempotencyKey: 'k1' }));
    const b = await h.broker.open(attention({ idempotencyKey: 'k1' }));
    expect(b.id).toBe(a.id);
    expect(b.reused).toBe(true);
    expect(h.broker.openCount()).toBe(1);
    await h.broker.resolve(a.id, { status: 'resolved' }, 'admin');
    // After settlement the key still answers with the stored outcome.
    const c = await h.broker.open(attention({ idempotencyKey: 'k1' }));
    expect(c.reused).toBe(true);
    expect((await c.promise).status).toBe('resolved');
    // A different session with the same key is a new request.
    const d = await h.broker.open(attention({ idempotencyKey: 'k1', sessionId: 'demo-00000002' }));
    expect(d.reused).toBe(false);
  });

  it('bounded queue: per-session and global limits throw RATE_LIMITED', async () => {
    const bounded = harness({ perSession: 2, global: 3 });
    await bounded.broker.open(attention());
    await bounded.broker.open(attention());
    await expect(bounded.broker.open(attention())).rejects.toMatchObject({ code: 'RATE_LIMITED' });
    await bounded.broker.open(attention({ sessionId: 'demo-00000002' }));
    await expect(
      bounded.broker.open(attention({ sessionId: 'demo-00000003' })),
    ).rejects.toMatchObject({
      code: 'RATE_LIMITED',
    });
  });
});

describe('OperatorRequestBroker — settlement', () => {
  let h: ReturnType<typeof harness>;
  beforeEach(() => {
    h = harness();
  });

  it('operator resolve settles the promise, resumes the lease, audits, publishes', async () => {
    const handle = await h.broker.open(attention());
    await h.clock.advance(500);
    const result = await h.broker.resolve(
      handle.id,
      { status: 'resolved', message: 'done' },
      'admin',
    );
    expect(result.ok).toBe(true);
    const outcome = await handle.promise;
    expect(outcome).toEqual({
      requestId: handle.id,
      status: 'resolved',
      message: 'done',
      resolvedBy: 'admin',
      resolutionReason: null,
      resolvedAt: 1500,
    });
    expect(h.leases.calls).toEqual(['pause:demo-00000001:1000', 'resume:demo-00000001:1500']);
    expect(h.broker.hasOpen('demo-00000001')).toBe(false);
    expect((await h.repos.requests.get(handle.id))?.status).toBe('resolved');
    expect(h.repos.actions.rows).toHaveLength(1);
    expect(h.repos.actions.rows[0]).toMatchObject({
      principalId: 'admin',
      action: 'attention.resolved',
      resourceKind: 'operator_request',
      resourceId: handle.id,
      details: { status: 'resolved', message: 'done' },
    });
    expect(h.events.names()).toEqual(['attention.created', 'attention.resolved']);
  });

  it('a second resolve reports not-open with the terminal status; unknown ids report null', async () => {
    const handle = await h.broker.open(attention());
    await h.broker.resolve(handle.id, { status: 'rejected' }, 'a');
    expect(await h.broker.resolve(handle.id, { status: 'resolved' }, 'b')).toEqual({
      ok: false,
      status: 'rejected',
    });
    expect(await h.broker.resolve('a-nope', { status: 'resolved' }, 'b')).toEqual({
      ok: false,
      status: null,
    });
  });

  it('times out through the injected clock with the timeout message', async () => {
    const handle = await h.broker.open(attention({ timeoutMs: 5_000 }));
    await h.clock.advance(4_999);
    expect(h.broker.hasOpen('demo-00000001')).toBe(true);
    await h.clock.advance(1);
    const outcome = await handle.promise;
    expect(outcome.status).toBe('timeout');
    expect(outcome.message).toBe(TIMEOUT_MESSAGE);
    expect(h.clock.pendingSleeps).toBe(0);
  });

  it('settling first cancels the deadline sleep (no late timeout)', async () => {
    const handle = await h.broker.open(attention({ timeoutMs: 5_000 }));
    await h.broker.resolve(handle.id, { status: 'resolved' }, 'admin');
    expect(h.clock.pendingSleeps).toBe(0);
    await h.clock.advance(10_000);
    expect((await h.repos.requests.get(handle.id))?.status).toBe('resolved');
  });

  it('cancel (heartbeat rejection / notifications/cancelled) settles cancelled with the cancellation text', async () => {
    const handle = await h.broker.open(attention());
    expect(await h.broker.cancel(handle.id)).toBe(true);
    const outcome = await handle.promise;
    expect(outcome.status).toBe('cancelled');
    expect(outcome.message).toBe(CANCELLED_MESSAGE);
    expect(await h.broker.cancel(handle.id)).toBe(false);
  });

  it('an aborted signal (disconnect) cancels the request', async () => {
    const controller = new AbortController();
    const handle = await h.broker.open(attention({ signal: controller.signal }));
    controller.abort();
    expect((await handle.promise).status).toBe('cancelled');
  });

  it('session close settles every open request of that session per reason without resuming the lease', async () => {
    const a = await h.broker.open(attention());
    const b = await h.broker.open(attention({ sessionId: 'demo-00000002' }));
    expect(await h.broker.settleForSession('demo-00000001', 'crash')).toBe(1);
    const outcome = await a.promise;
    expect(outcome.status).toBe('rejected');
    expect(outcome.message).toBe(SESSION_CLOSE_MESSAGE.crash);
    expect(outcome.message).toContain('session_dead');
    expect(h.leases.calls.some((c) => c.startsWith('resume:demo-00000001'))).toBe(false);
    expect(h.broker.hasOpen('demo-00000002')).toBe(true);
    const reasons = [
      'user',
      'lease_expired',
      'shutdown',
      'interrupted',
      'operator',
      'launch_failed',
    ] as const;
    for (const [n, reason] of reasons.entries()) {
      const sessionId = `demo-0000001${n}`;
      const r = await h.broker.open(attention({ sessionId }));
      await h.broker.settleForSession(sessionId, reason);
      expect((await r.promise).message).toBe(SESSION_CLOSE_MESSAGE[reason]);
    }
    await h.broker.settleForSession('demo-00000002', 'user');
    expect((await b.promise).message).toBe(
      'Session was closed while the attention request was open (session_closed).',
    );
  });

  it('shutdown rejects every open request with the server_shutdown message', async () => {
    const a = await h.broker.open(attention());
    await h.broker.shutdown();
    await h.broker.shutdown();
    const outcome = await a.promise;
    expect(outcome.status).toBe('rejected');
    expect(outcome.message).toBe(SESSION_CLOSE_MESSAGE.shutdown);
    expect(outcome.message).toContain('server_shutdown');
  });
});

describe('OperatorRequestBroker — results and recovery', () => {
  let h: ReturnType<typeof harness>;
  beforeEach(() => {
    h = harness();
  });

  it('result: live promise while open, stored outcome once settled, null when unknown', async () => {
    const handle = await h.broker.open(attention());
    const reattach = h.broker.result(handle.id);
    await h.broker.resolve(handle.id, { status: 'rejected', message: 'nope' }, 'admin');
    expect((await reattach)?.status).toBe('rejected');
    const again = await h.broker.result(handle.id);
    expect(again?.message).toBe('nope');
    expect(await h.broker.result('a-doesnotexist1')).toBeNull();
  });

  it('a stored pending row without a waiter is rejected on read (escaped orphan)', async () => {
    await h.repos.requests.insert({
      requestId: 'a-orphan000001',
      kind: 'attention',
      sessionId: 'demo-00000001',
      owner: 'local',
      reason: 'stuck',
      mode: 'takeover',
      entryName: null,
      tool: null,
      toolEventId: null,
      pageUrl: null,
      options: null,
      idempotencyKey: null,
      createdAt: 1,
      deadlineAt: null,
    });
    const outcome = await h.broker.result('a-orphan000001');
    expect(outcome?.status).toBe('rejected');
    expect(outcome?.message).toBe(RESTART_MESSAGE);
    expect((await h.repos.requests.get('a-orphan000001'))?.status).toBe('rejected');
  });

  it('recoverOrphans marks pending rows of a previous process as rejected', async () => {
    await h.repos.requests.insert({
      requestId: 'a-orphan000002',
      kind: 'attention',
      sessionId: 'demo-00000001',
      owner: 'local',
      reason: 'stuck',
      mode: 'takeover',
      entryName: null,
      tool: null,
      toolEventId: null,
      pageUrl: null,
      options: null,
      idempotencyKey: null,
      createdAt: 1,
      deadlineAt: null,
    });
    const live = await h.broker.open(attention());
    expect(await h.broker.recoverOrphans()).toBe(1);
    expect((await h.repos.requests.get('a-orphan000002'))?.message).toBe(RESTART_MESSAGE);
    expect(h.broker.hasOpen('demo-00000001')).toBe(true);
    await h.broker.cancel(live.id);
  });

  it('listOpen / history expose the queue and the audit trail', async () => {
    const a = await h.broker.open(attention());
    await h.clock.advance(1);
    const b = await h.broker.open({
      kind: 'vault_confirm',
      sessionId: 'demo-00000001',
      owner: 'local',
      reason: 'x',
    });
    expect(h.broker.listOpen().map((r) => r.requestId)).toEqual([a.id, b.id]);
    expect(h.broker.listOpen('vault_confirm').map((r) => r.requestId)).toEqual([b.id]);
    await h.broker.resolve(a.id, { status: 'resolved' }, 'admin');
    const page = await h.broker.history({ kind: 'attention' });
    expect(page.items).toHaveLength(1);
    expect(page.items[0]?.waitedMs).toBe(1);
    expect(await h.broker.get(b.id)).not.toBeNull();
  });
});
