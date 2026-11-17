/** @module app/attention/attention-security-intercepts.test — `/attention` lists and decides `security_intercept` requests beside attention ones, `get_attention_result` answers them to the owning principal, a takeover site check permits live-view input (spec 13 §9.5, amends D-10), and the broker publishes them as `attention.*` with their kind and template. */

import { describe, expect, it } from 'bun:test';
import { FakeClock } from '../../../test/helpers/fake-clock.ts';
import { FakeIdGenerator } from '../../../test/helpers/fake-id-generator.ts';
import { createVaultRepos } from '../../../test/helpers/in-memory-vault-repos.ts';
import { RecordingEventBus } from '../../../test/helpers/recording-event-bus.ts';
import { createCollectingLogger } from '../../../test/helpers/test-logger.ts';
import { OperatorRequestBroker } from '../../domain/operator-requests/broker.ts';
import type { OperatorRequestEvents } from '../../domain/operator-requests/types.ts';
import { AttentionService } from './attention-service.ts';

const SESSION = 'demo-00000001';

function harness() {
  const clock = new FakeClock(10_000);
  const repos = createVaultRepos();
  const events = new RecordingEventBus<OperatorRequestEvents>();
  const broker = new OperatorRequestBroker({
    requests: repos.requests,
    actions: repos.actions,
    leases: { pause: () => undefined, resume: () => undefined },
    events,
    clock,
    ids: new FakeIdGenerator(),
    logger: createCollectingLogger(),
  });
  const service = new AttentionService({
    broker,
    clock,
    logger: createCollectingLogger(),
    config: { transport: 'http', attentionTimeoutMs: 21_600_000, minAttentionWaitMs: 0 },
  });
  const intercept = (mode?: 'takeover') =>
    broker.open({
      kind: 'security_intercept',
      sessionId: SESSION,
      owner: 'agent-1',
      reason: 'Site A security check',
      ...(mode !== undefined && { mode }),
      options: { reason: mode === undefined ? 'write_confirm' : 'challenge', site: 'site-a.test' },
      templateId: 'tp-aaaaaaaaaa',
      timeoutMs: 60_000,
    });
  return { broker, service, events, intercept, repos };
}

describe('/attention and security intercepts', () => {
  it('lists, counts and facets security intercepts beside attention requests, never vault confirms', async () => {
    const h = harness();
    await h.broker.open({ kind: 'attention', sessionId: SESSION, owner: 'agent-1', reason: 'r' });
    await h.intercept();
    await h.broker.open({
      kind: 'vault_confirm',
      sessionId: SESSION,
      owner: 'agent-1',
      reason: 'fill',
      entryName: 'x',
    });
    expect(h.service.openCount()).toBe(2);
    expect(h.service.listOpen().map((r) => r.kind)).toEqual(['attention', 'security_intercept']);
    const page = await h.service.history({ kind: 'vault_confirm' });
    expect(page.items.map((r) => r.kind).sort()).toEqual(['attention', 'security_intercept']);
    const intercept = page.items.find((r) => r.kind === 'security_intercept');
    expect(intercept?.templateId).toBe('tp-aaaaaaaaaa');
    const facets = await h.service.facets({});
    expect(facets.statuses.find((f) => f.value === 'pending')?.count).toBe(2);
  });

  it('resolve approves and reject denies a security intercept', async () => {
    const h = harness();
    const approved = await h.intercept();
    const denied = await h.intercept();
    expect(await h.service.resolve(approved.id, 'admin')).toBe('resolved');
    expect(await h.service.reject(denied.id, 'admin')).toBe('rejected');
    expect((await approved.promise).status).toBe('resolved');
    expect((await denied.promise).resolvedBy).toBe('admin');
  });

  it('get_attention_result answers a security intercept to the owning principal only', async () => {
    const h = harness();
    const handle = await h.intercept();
    await h.service.resolve(handle.id, 'admin');
    expect(await h.service.result(handle.id, { principal: 'agent-1' })).toMatchObject({
      status: 'resolved',
      request_id: handle.id,
    });
    const other = await h.service.result(handle.id, { principal: 'agent-2' });
    expect(other.status).toBe('rejected');
    expect(other.message).toContain('Unknown');
  });

  it('a takeover site check permits live-view input; a write approval does not', async () => {
    const h = harness();
    await h.intercept();
    expect(h.service.isInputPermitted(SESSION, 'input')).toBe(false);
    const check = await h.intercept('takeover');
    expect(h.service.isInputPermitted(SESSION, 'input')).toBe(true);
    await h.service.resolve(check.id, 'admin');
    expect(h.service.isInputPermitted(SESSION, 'input')).toBe(false);
  });

  it('the broker publishes intercepts as attention.created/resolved with kind and template', async () => {
    const h = harness();
    const handle = await h.intercept();
    await h.service.reject(handle.id, 'admin');
    expect(h.events.names()).toEqual(['attention.created', 'attention.resolved']);
    const created = h.events.published[0]?.payload as OperatorRequestEvents['attention.created'];
    expect(created.request).toMatchObject({
      kind: 'security_intercept',
      template_id: 'tp-aaaaaaaaaa',
    });
  });
});
