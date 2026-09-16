/** @module app/events/bus.test — ordering, consumer isolation, async rejection reporting and catalog naming of the in-process bus. */

import { describe, expect, it } from 'bun:test';
import { PageRow } from '@browserhive/contracts/http';
import { SessionId } from '@browserhive/contracts/ids';
import { CollectingLogger } from '../../../test/helpers/collecting-logger.ts';
import { FakeClock } from '../../../test/helpers/fake-clock.ts';
import type { DomainEvent } from '../../ports/event-bus.ts';
import { InProcessEventBus } from './bus.ts';
import {
  type DomainEventName,
  type DomainEvents,
  type PublishedEvent,
  sessionIdOf,
} from './catalog.ts';

type TestEvents = {
  readonly 'a.one': { readonly n: number };
  readonly 'b.two': { readonly s: string };
};

function setup(onHandlerError?: (error: unknown, event: DomainEvent) => void) {
  const clock = new FakeClock(5_000);
  const logger = new CollectingLogger();
  const bus = new InProcessEventBus<TestEvents>({
    clock,
    logger,
    ...(onHandlerError !== undefined && { onHandlerError }),
  });
  return { clock, logger, bus };
}

describe('InProcessEventBus', () => {
  it('delivers named handlers in subscription order, then subscribeAll handlers, with the clock time', () => {
    const { bus, clock } = setup();
    const seen: string[] = [];
    bus.subscribeAll((e) => {
      seen.push(`all:${e.name}`);
    });
    bus.subscribe('a.one', (e) => {
      seen.push(`n1:${e.payload.n}@${e.at}`);
    });
    bus.subscribe('a.one', (e) => {
      seen.push(`n2:${e.payload.n}`);
    });
    bus.subscribe('b.two', (e) => {
      seen.push(`b:${e.payload.s}`);
    });
    clock.set(6_000).catch(() => undefined);
    bus.publish('a.one', { n: 1 });
    expect(seen).toEqual(['n1:1@6000', 'n2:1', 'all:a.one']);
    expect(bus.subscriberCount('a.one')).toBe(3);
    expect(bus.subscriberCount('b.two')).toBe(2);
  });

  it('a throwing sync handler is logged and never stops the others', () => {
    const { bus, logger } = setup();
    const seen: string[] = [];
    bus.subscribe('a.one', () => {
      throw new Error('first fails');
    });
    bus.subscribe('a.one', () => {
      seen.push('second');
    });
    bus.subscribeAll(() => {
      seen.push('all');
    });
    bus.publish('a.one', { n: 2 });
    expect(seen).toEqual(['second', 'all']);
    const failures = logger.at('error').filter((r) => r.msg === 'event handler failed');
    expect(failures).toHaveLength(1);
    expect(failures[0]?.fields?.['event']).toBe('a.one');
  });

  it('a rejecting async handler is reported through onHandlerError without an unhandled rejection', async () => {
    const reported: Array<{ error: unknown; name: string }> = [];
    const { bus, logger } = setup((error, event) => {
      reported.push({ error, name: event.name });
    });
    bus.subscribe('b.two', async () => {
      throw new Error('async boom');
    });
    let others = 0;
    bus.subscribe('b.two', async () => {
      others++;
    });
    bus.publish('b.two', { s: 'x' });
    await Promise.resolve();
    await Promise.resolve();
    expect(others).toBe(1);
    expect(reported).toHaveLength(1);
    expect(reported[0]?.name).toBe('b.two');
    expect(logger.at('error')).toHaveLength(1);
  });

  it('a throwing onHandlerError hook is swallowed', () => {
    const { bus } = setup(() => {
      throw new Error('hook fails');
    });
    bus.subscribe('a.one', () => {
      throw new Error('boom');
    });
    expect(() => bus.publish('a.one', { n: 0 })).not.toThrow();
  });

  it('unsubscribe stops delivery for named and catch-all subscriptions', () => {
    const { bus } = setup();
    let named = 0;
    let all = 0;
    const offNamed = bus.subscribe('a.one', () => {
      named++;
    });
    const offAll = bus.subscribeAll(() => {
      all++;
    });
    bus.publish('a.one', { n: 1 });
    offNamed();
    bus.publish('a.one', { n: 1 });
    offAll();
    bus.publish('a.one', { n: 1 });
    expect(named).toBe(1);
    expect(all).toBe(2);
    expect(bus.subscriberCount('a.one')).toBe(0);
  });
});

describe('DomainEvents catalog', () => {
  it('every event name is a versioned dotted name known to the catalog', () => {
    const names = [
      'session.opened',
      'session.updated',
      'session.closed',
      'session.removed',
      'session.warning',
      'session.proxy_assigned',
      'tool.called',
      'page.visited',
      'screenshot.captured',
      'blocklist.hit',
      'blocklist.reloaded',
      'vault.access',
      'attention.created',
      'attention.resolved',
      'vault.confirm.created',
      'vault.confirm.resolved',
      'vault.binding.changed',
      'vault.policy.changed',
      'vault.lock_state',
      'system.degraded',
      'system.recovered',
      'system.tick',
      'system.capacity',
      'system.status',
      'retention.completed',
      'notification.created',
      'notification.updated',
      'notification.read',
      'notification.dismissed',
      'auth.login_success',
      'auth.logout',
      'auth.login_failure',
      'auth.lockout',
      'auth.password_changed',
      'auth.token_issued',
      'auth.token_revoked',
      'auth.session_revoked',
      'log.record',
    ] as const satisfies readonly DomainEventName[];
    for (const name of names) expect(name).toMatch(/^[a-z]+(\.[a-z_]+)+$/);
    const closed: DomainEvents['session.closed'] = {
      type: 'session.closed',
      session_id: SessionId.parse('shop-00000001'),
      closed_at: 1,
      reason: 'user',
    };
    expect(closed.type).toBe('session.closed');
  });

  it('sessionIdOf finds direct and nested session ids', () => {
    const direct: PublishedEvent<'session.closed'> = {
      name: 'session.closed',
      at: 1,
      payload: {
        type: 'session.closed',
        session_id: SessionId.parse('shop-00000001'),
        closed_at: 1,
        reason: 'user',
      },
    };
    const row = PageRow.parse({
      event_id: 'e-01ARZ3NDEKTSV4RRFFQ69G5FAV',
      session_id: 'docs-00000002',
      tab_id: 't-000001',
      url: 'https://a.test/',
      title: null,
      domain: 'a.test',
      category: 'public',
      ts: 1,
    });
    const nested: PublishedEvent<'page.visited'> = {
      name: 'page.visited',
      at: 1,
      payload: { type: 'page.visited', row },
    };
    const none: PublishedEvent<'system.tick'> = {
      name: 'system.tick',
      at: 1,
      payload: { type: 'system.tick', now: 1 },
    };
    expect(sessionIdOf(direct)).toBe('shop-00000001');
    expect(sessionIdOf(nested)).toBe('docs-00000002');
    expect(sessionIdOf(none)).toBeNull();
  });
});
