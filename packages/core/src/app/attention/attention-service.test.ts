/** @module app/attention/attention-service.test — request/result/resolve semantics and the live-view input gate */

import { beforeEach, describe, expect, it } from 'bun:test';
import { FakeClock } from '../../../test/helpers/fake-clock.ts';
import { FakeIdGenerator } from '../../../test/helpers/fake-id-generator.ts';
import { createVaultRepos } from '../../../test/helpers/in-memory-vault-repos.ts';
import { RecordingEventBus } from '../../../test/helpers/recording-event-bus.ts';
import { createCollectingLogger } from '../../../test/helpers/test-logger.ts';
import { OperatorRequestBroker } from '../../domain/operator-requests/broker.ts';
import { HEARTBEAT_INTERVAL_MS } from '../../domain/operator-requests/heartbeat.ts';
import { CANCELLED_MESSAGE, TIMEOUT_MESSAGE } from '../../domain/operator-requests/messages.ts';
import type { OperatorRequestEvents } from '../../domain/operator-requests/types.ts';
import type { EventPublisher } from '../../ports/event-bus.ts';
import type { DomainEvents } from '../events/catalog.ts';
import { AttentionService } from './attention-service.ts';

/** Compile-time: the composition root's `EventBus<DomainEvents>` satisfies the broker's publisher. */
type BusFits =
  EventPublisher<DomainEvents> extends EventPublisher<OperatorRequestEvents> ? true : never;
const busFits: BusFits = true;
void busFits;

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

function harness(transport: 'http' | 'stdio' = 'http') {
  const clock = new FakeClock(10_000);
  const repos = createVaultRepos();
  const leases = { pause: () => undefined, resume: () => undefined };
  const broker = new OperatorRequestBroker({
    requests: repos.requests,
    actions: repos.actions,
    leases,
    events: new RecordingEventBus<OperatorRequestEvents>(),
    clock,
    ids: new FakeIdGenerator(),
    logger: createCollectingLogger(),
  });
  const service = new AttentionService({
    broker,
    clock,
    logger: createCollectingLogger(),
    config: { transport, attentionTimeoutMs: 21_600_000, minAttentionWaitMs: 1_800_000 },
  });
  return { clock, repos, broker, service };
}

describe('AttentionService.request', () => {
  let h: ReturnType<typeof harness>;
  beforeEach(() => {
    h = harness();
  });

  it('throws ATTENTION_REQUIRES_HTTP under stdio before anything else', async () => {
    const stdio = harness('stdio');
    await expect(
      stdio.service.request(
        'demo-00000001',
        { reason: 'x', mode: 'takeover' },
        { principal: 'local' },
      ),
    ).rejects.toMatchObject({
      code: 'ATTENTION_REQUIRES_HTTP',
      details: { tool: 'request_attention' },
    });
    await expect(stdio.service.result('a-1', { principal: 'local' })).rejects.toMatchObject({
      code: 'ATTENTION_REQUIRES_HTTP',
      details: { tool: 'get_attention_result' },
    });
    expect(stdio.repos.requests.rows.size).toBe(0);
  });

  it('blocks until the operator resolves; message/resolved_by present, request id shaped a-<12>', async () => {
    const pending = h.service.request(
      'demo-00000001',
      { reason: 'login', mode: 'takeover', options: { hint: 'x' } },
      {
        principal: 'local',
        toolEventId: 'e-00000000000000000000000001',
        pageUrl: 'https://x.test/',
      },
    );
    await flush();
    const [open] = h.service.listOpen();
    expect(open).toMatchObject({
      mode: 'takeover',
      tool: 'request_attention',
      toolEventId: 'e-00000000000000000000000001',
      pageUrl: 'https://x.test/',
    });
    expect(h.service.hasOpenAttention('demo-00000001')).toBe(true);
    expect(await h.service.resolve(open?.requestId ?? '', 'admin', 'done')).toBe('resolved');
    const outcome = await pending;
    expect(outcome).toEqual({
      status: 'resolved',
      message: 'done',
      resolved_by: 'admin',
      resolved_at: 10_000,
      request_id: open?.requestId ?? '',
    });
    expect(outcome.request_id).toMatch(/^a-\d{12}$/);
  });

  it('omits message and resolved_by when absent (timeout)', async () => {
    const pending = h.service.request(
      'demo-00000001',
      { reason: 'x', mode: 'notify', maxWaitSeconds: 1 },
      { principal: 'local' },
    );
    await flush();
    // floor: 1 s is raised to the 30 min floor
    const [open] = h.service.listOpen();
    expect(open?.deadlineAt).toBe(10_000 + 1_800_000);
    await h.clock.advance(1_800_000);
    const outcome = await pending;
    expect(outcome).toEqual({
      status: 'timeout',
      message: TIMEOUT_MESSAGE,
      resolved_at: 1_810_000,
      request_id: open?.requestId ?? '',
    });
    expect('resolved_by' in outcome).toBe(false);
  });

  it('max_wait 0/undefined uses the server cap; never above it', async () => {
    const a = h.service.request(
      'demo-00000001',
      { reason: 'x', mode: 'notify', maxWaitSeconds: 0 },
      { principal: 'local' },
    );
    const b = h.service.request(
      'demo-00000001',
      { reason: 'y', mode: 'notify', maxWaitSeconds: 999_999 },
      { principal: 'local' },
    );
    await flush();
    const open = h.service.listOpen();
    expect(open.map((r) => r.deadlineAt)).toEqual([10_000 + 21_600_000, 10_000 + 21_600_000]);
    await h.broker.shutdown();
    await Promise.all([a, b]);
  });

  it('sends heartbeats every 25 s and cancels when a heartbeat is rejected', async () => {
    const reports: number[] = [];
    let fail = false;
    const pending = h.service.request(
      'demo-00000001',
      { reason: 'x', mode: 'takeover' },
      {
        principal: 'local',
        reportProgress: (p) => {
          reports.push(p.progress);
          return fail ? Promise.reject(new Error('gone')) : Promise.resolve();
        },
      },
    );
    await flush();
    await h.clock.advance(HEARTBEAT_INTERVAL_MS);
    await flush();
    fail = true;
    await h.clock.advance(HEARTBEAT_INTERVAL_MS);
    await flush();
    const outcome = await pending;
    expect(reports).toEqual([25_000, 50_000]);
    expect(outcome.status).toBe('cancelled');
    expect(outcome.message).toBe(CANCELLED_MESSAGE);
    expect(h.service.hasOpenAttention('demo-00000001')).toBe(false);
  });

  it('an aborted signal cancels the request (client disconnect)', async () => {
    const controller = new AbortController();
    const pending = h.service.request(
      'demo-00000001',
      { reason: 'x', mode: 'takeover' },
      { principal: 'local', signal: controller.signal },
    );
    await flush();
    controller.abort();
    expect((await pending).status).toBe('cancelled');
  });

  it('idempotencyKey returns the same request', async () => {
    const a = h.service.request(
      'demo-00000001',
      { reason: 'x', mode: 'takeover', idempotencyKey: 'k' },
      { principal: 'local' },
    );
    await flush();
    const b = h.service.request(
      'demo-00000001',
      { reason: 'x', mode: 'takeover', idempotencyKey: 'k' },
      { principal: 'local' },
    );
    await flush();
    expect(h.service.openCount()).toBe(1);
    const [open] = h.service.listOpen();
    await h.service.reject(open?.requestId ?? '', 'admin', 'no');
    const [ra, rb] = await Promise.all([a, b]);
    expect(ra.request_id).toBe(rb.request_id);
    expect(rb.status).toBe('rejected');
  });
});

describe('AttentionService.result', () => {
  let h: ReturnType<typeof harness>;
  beforeEach(() => {
    h = harness();
  });

  it('returns immediately for a settled request of the same principal', async () => {
    const pending = h.service.request(
      'demo-00000001',
      { reason: 'x', mode: 'notify' },
      { principal: 'p-1' },
    );
    await flush();
    const [open] = h.service.listOpen();
    await h.service.reject(open?.requestId ?? '', 'admin', 'nope');
    await pending;
    const again = await h.service.result(open?.requestId ?? '', { principal: 'p-1' });
    expect(again).toMatchObject({ status: 'rejected', message: 'nope', resolved_by: 'admin' });
  });

  it('blocks on an in-flight request then settles', async () => {
    const pending = h.service.request(
      'demo-00000001',
      { reason: 'x', mode: 'takeover' },
      { principal: 'p-1' },
    );
    await flush();
    const [open] = h.service.listOpen();
    const reattach = h.service.result(open?.requestId ?? '', { principal: 'p-1' });
    await h.service.resolve(open?.requestId ?? '', 'admin');
    expect((await reattach).status).toBe('resolved');
    await pending;
  });

  it("unknown ids and another principal's requests answer identically: rejected with the unknown message", async () => {
    const pending = h.service.request(
      'demo-00000001',
      { reason: 'x', mode: 'takeover' },
      { principal: 'p-1' },
    );
    await flush();
    const [open] = h.service.listOpen();
    const foreign = await h.service.result(open?.requestId ?? '', { principal: 'p-2' });
    expect(foreign).toEqual({
      status: 'rejected',
      message: `Unknown attention request '${open?.requestId}'.`,
      resolved_at: 10_000,
      request_id: open?.requestId ?? '',
    });
    const unknown = await h.service.result('a-doesnotexist1', { principal: 'p-1' });
    expect(unknown.message).toBe("Unknown attention request 'a-doesnotexist1'.");
    await h.broker.shutdown();
    await pending;
  });
});

describe('AttentionService — operator side and input gate', () => {
  let h: ReturnType<typeof harness>;
  beforeEach(() => {
    h = harness();
  });

  it('resolve on a settled request throws ATTENTION_NOT_OPEN; unknown throws NOT_FOUND', async () => {
    const pending = h.service.request(
      'demo-00000001',
      { reason: 'x', mode: 'takeover' },
      { principal: 'local' },
    );
    await flush();
    const [open] = h.service.listOpen();
    await h.service.resolve(open?.requestId ?? '', 'admin');
    await pending;
    await expect(h.service.reject(open?.requestId ?? '', 'admin')).rejects.toMatchObject({
      code: 'ATTENTION_NOT_OPEN',
      details: { request_id: open?.requestId, status: 'resolved' },
    });
    await expect(h.service.resolve('a-nope', 'admin')).rejects.toMatchObject({ code: 'NOT_FOUND' });
    const history = await h.service.history({});
    expect(history.items).toHaveLength(1);
  });

  it('input is accepted only while a takeover request is open; set_viewport is never gated', async () => {
    expect(h.service.isInputPermitted('demo-00000001', 'session.set_viewport')).toBe(true);
    expect(h.service.isInputPermitted('demo-00000001', 'input')).toBe(false);
    expect(() => h.service.assertInputPermitted('demo-00000001', 'input')).toThrow(
      "Input is not permitted on session 'demo-00000001': no takeover attention request is open.",
    );
    const notify = h.service.request(
      'demo-00000001',
      { reason: 'x', mode: 'notify' },
      { principal: 'local' },
    );
    await flush();
    expect(h.service.hasOpenAttention('demo-00000001')).toBe(true);
    expect(h.service.isInputPermitted('demo-00000001', 'input')).toBe(false);
    const takeover = h.service.request(
      'demo-00000001',
      { reason: 'y', mode: 'takeover' },
      { principal: 'local' },
    );
    await flush();
    expect(h.service.isInputPermitted('demo-00000001', 'input')).toBe(true);
    expect(() => h.service.assertInputPermitted('demo-00000001', 'input')).not.toThrow();
    await h.broker.shutdown();
    await Promise.all([notify, takeover]);
    expect(h.service.isInputPermitted('demo-00000001', 'input')).toBe(false);
  });
});
