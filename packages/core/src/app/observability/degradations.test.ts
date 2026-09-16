/** @module app/observability/degradations.test — aggregation by code + details fingerprint, resolve, unhandled, never throws. */

import { describe, expect, it } from 'bun:test';
import { SystemEvent } from '@browserhive/contracts/http';
import { CollectingLogger } from '../../../test/helpers/collecting-logger.ts';
import { FakeClock } from '../../../test/helpers/fake-clock.ts';
import { FakeIdGenerator } from '../../../test/helpers/fake-id-generator.ts';
import { InMemorySystemEventRepository } from '../../../test/helpers/in-memory-repos.ts';
import { RecordingEventBus } from '../../../test/helpers/recording-event-bus.ts';
import type { DomainEvents } from '../events/catalog.ts';
import { DegradationService, fingerprint } from './degradations.ts';

function setup(repo = new InMemorySystemEventRepository()) {
  const clock = new FakeClock();
  const bus = new RecordingEventBus<DomainEvents>();
  const service = new DegradationService({
    repo,
    bus,
    clock,
    ids: new FakeIdGenerator(),
    logger: new CollectingLogger(),
  });
  return { clock, bus, repo, service };
}

describe('fingerprint', () => {
  it('is independent of key order', () => {
    expect(fingerprint({ a: 1, b: { d: 2, c: 3 } })).toBe(fingerprint({ b: { c: 3, d: 2 }, a: 1 }));
    expect(fingerprint(undefined)).toBe('null');
  });
});

describe('DegradationService', () => {
  it('same code + details aggregate into one row with a count', async () => {
    const { service, repo, clock, bus } = setup();
    service.report({ code: 'X', severity: 'warn', message: 'm', details: { step: 'a', n: 1 } });
    await clock.advance(1000);
    service.report({ code: 'X', severity: 'warn', message: 'm', details: { n: 1, step: 'a' } });
    await service.idle();
    expect(repo.rows).toHaveLength(1);
    expect(repo.rows[0]?.count).toBe(2);
    expect(repo.rows[0]?.lastSeenAt).toBe((repo.rows[0]?.firstSeenAt ?? 0) + 1000);
    const degraded = bus.published.filter((p) => p.name === 'system.degraded');
    expect(degraded).toHaveLength(2);
    const last = degraded[1]?.payload as DomainEvents['system.degraded'];
    expect(SystemEvent.safeParse(last.event).success).toBe(true);
    expect(last.event.count).toBe(2);
  });

  it('different details make separate rows; resolve closes every row of the code', async () => {
    const { service, repo, bus } = setup();
    service.report({ code: 'X', severity: 'warn', message: 'm', details: { step: 'a' } });
    service.report({ code: 'X', severity: 'warn', message: 'm', details: { step: 'b' } });
    service.report({ code: 'Y', severity: 'error', message: 'm' });
    await service.idle();
    expect(repo.rows).toHaveLength(3);
    expect(service.hasOpen('error')).toBe(true);
    service.recovered('X');
    await service.idle();
    expect((await service.open()).map((r) => r.code)).toEqual(['Y']);
    expect(bus.names().filter((n) => n === 'system.recovered')).toHaveLength(2);
    expect(await service.resolve('X')).toBe(0);
  });

  it('a new occurrence after resolution opens a fresh row', async () => {
    const { service, repo } = setup();
    await service.record({ code: 'X', severity: 'warn', message: 'm' });
    await service.resolve('X');
    await service.record({ code: 'X', severity: 'warn', message: 'm' });
    expect(repo.rows).toHaveLength(2);
    expect(repo.rows[1]?.count).toBe(1);
  });

  it('unhandled records UNHANDLED with kind and error name', async () => {
    const { service, repo } = setup();
    service.unhandled(new TypeError('boom'), 'rejection');
    service.unhandled(new TypeError('boom again'), 'rejection');
    await service.idle();
    expect(repo.rows).toHaveLength(1);
    expect(repo.rows[0]).toMatchObject({
      code: 'UNHANDLED',
      severity: 'error',
      count: 2,
      details: { kind: 'rejection', name: 'TypeError' },
    });
  });

  it('load hydrates open rows; repository failures never throw', async () => {
    const repo = new InMemorySystemEventRepository();
    await repo.record({
      eventId: 'e-1',
      code: 'Z',
      severity: 'warn',
      message: 'm',
      details: null,
      at: 1,
    });
    const { service } = setup(repo);
    await service.load();
    expect(service.hasOpen()).toBe(true);
    repo.record = () => Promise.reject(new Error('disk full'));
    service.report({ code: 'Q', severity: 'warn', message: 'm' });
    await service.idle();
    expect(service.counters.failed).toBe(1);
  });
});
