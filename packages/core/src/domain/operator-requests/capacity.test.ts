/** @module domain/operator-requests/capacity.test — review PR #83 M3: concurrent opens cannot pass the broker's per-session or global bound while their inserts are in flight (slow storage), and a failed insert gives its slot back. */

import { describe, expect, it } from 'bun:test';
import { FakeClock } from '../../../test/helpers/fake-clock.ts';
import { FakeIdGenerator } from '../../../test/helpers/fake-id-generator.ts';
import { createVaultRepos } from '../../../test/helpers/in-memory-vault-repos.ts';
import { RecordingEventBus } from '../../../test/helpers/recording-event-bus.ts';
import { createCollectingLogger } from '../../../test/helpers/test-logger.ts';
import { isAppError } from '../../kernel/errors/app-error.ts';
import { OperatorRequestBroker } from './broker.ts';
import type { OperatorRequestEvents } from './types.ts';

function slowBroker(limits: { perSession: number; global: number }, failFirst = false) {
  const repos = createVaultRepos();
  let calls = 0;
  const requests = Object.create(repos.requests) as typeof repos.requests;
  requests.insert = async (record) => {
    calls += 1;
    await new Promise((r) => setTimeout(r, 20));
    if (failFirst && calls === 1) throw new Error('disk full');
    return repos.requests.insert(record);
  };
  return new OperatorRequestBroker({
    requests,
    actions: repos.actions,
    leases: { pause: () => undefined, resume: () => undefined },
    events: new RecordingEventBus<OperatorRequestEvents>(),
    clock: new FakeClock(1_000),
    ids: new FakeIdGenerator(),
    logger: createCollectingLogger(),
    limits,
  });
}

const open = (broker: OperatorRequestBroker, sessionId: string) =>
  broker.open({ kind: 'attention', sessionId, owner: 'agent', reason: 'r' }).then(
    () => 'opened',
    (error: unknown) => (isAppError(error) ? error.code : 'error'),
  );

describe('OperatorRequestBroker capacity under concurrency (M3)', () => {
  it('20 concurrent opens on one session open exactly perSession', async () => {
    const broker = slowBroker({ perSession: 8, global: 256 });
    const results = await Promise.all(
      Array.from({ length: 20 }, () => open(broker, 'demo-00000001')),
    );
    expect(results.filter((r) => r === 'opened')).toHaveLength(8);
    expect(results.filter((r) => r === 'RATE_LIMITED')).toHaveLength(12);
    expect(broker.openCount()).toBe(8);
  });

  it('concurrent opens over many sessions stop at the global bound', async () => {
    const broker = slowBroker({ perSession: 8, global: 10 });
    const results = await Promise.all(
      Array.from({ length: 25 }, (_, i) => open(broker, `demo-${String(i).padStart(8, '0')}`)),
    );
    expect(results.filter((r) => r === 'opened')).toHaveLength(10);
    expect(broker.openCount()).toBe(10);
  });

  it('a failed insert gives its slot back', async () => {
    const broker = slowBroker({ perSession: 1, global: 10 }, true);
    expect(await open(broker, 'demo-00000001')).toBe('error');
    expect(await open(broker, 'demo-00000001')).toBe('opened');
  });
});
