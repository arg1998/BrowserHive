/** @module app/notifications/action-listeners.test — one press listener per channel with act buttons (spec 03 §9.6): started with the registry, replaced when the adapter's source changes, stopped when act buttons go off or the channel is removed; state changes re-publish the channel. Also the outbox's minting seam: tokens only for channels that receive presses. */

import { describe, expect, it } from 'bun:test';
import { CollectingLogger } from '../../../test/helpers/collecting-logger.ts';
import { capabilities, channelRecord, FakeChannel } from '../../../test/helpers/fake-channel.ts';
import { FakeClock } from '../../../test/helpers/fake-clock.ts';
import { FakeIdGenerator } from '../../../test/helpers/fake-id-generator.ts';
import { InMemoryRepositories, InMemoryUnitOfWork } from '../../../test/helpers/in-memory-repos.ts';
import type {
  ListenerStatus,
  PressHandler,
  PressSource,
} from '../../ports/notification-channel.ts';
import type { NotificationChannelRecord } from '../../ports/persistence/records.ts';
import { NotificationActionListeners } from './action-listeners.ts';
import { ChannelRegistry } from './channel-registry.ts';
import { createLocalLinkBuilder } from './links.ts';
import { NotificationService } from './notification-service.ts';
import { NotificationOutbox } from './outbox.ts';
import { attentionCreated } from './test-fixtures.ts';

class FakeSource implements PressSource {
  readonly handlers: PressHandler[] = [];
  stops = 0;
  private notify: ((s: ListenerStatus) => void) | null = null;
  current: ListenerStatus = { state: 'connecting', since: 0, detail: null };

  listen(handler: PressHandler, onStatus: (s: ListenerStatus) => void): () => void {
    this.handlers.push(handler);
    this.notify = onStatus;
    return () => {
      this.stops += 1;
    };
  }

  status(): ListenerStatus {
    return this.current;
  }

  set(state: ListenerStatus['state']): void {
    this.current = { state, since: 1, detail: null };
    this.notify?.(this.current);
  }
}

async function setup(record: NotificationChannelRecord) {
  const repos = new InMemoryRepositories();
  const clock = new FakeClock();
  await repos.notificationChannels.upsert(record);
  const sources: FakeSource[] = [];
  const registry = new ChannelRegistry({
    repo: repos.notificationChannels,
    clock,
    ids: new FakeIdGenerator(),
    logger: new CollectingLogger(),
    factories: new Map([
      [
        'fake',
        (row) => {
          const fake = new FakeChannel(row.channelId, capabilities({ actButtons: true }));
          if (row.rules.act_buttons !== true) return fake;
          const source = new FakeSource();
          sources.push(source);
          return Object.assign(fake, { presses: source });
        },
      ],
    ]),
  });
  await registry.load();
  const changed: string[] = [];
  const listeners = new NotificationActionListeners({
    registry,
    handler: async () => ({ outcome: 'done', text: 'ok', refused: false }),
    logger: new CollectingLogger(),
    onStatus: (id) => changed.push(id),
  });
  return { repos, clock, registry, listeners, sources, changed };
}

describe('NotificationActionListeners', () => {
  it('listens to channels with act buttons and follows registry reloads', async () => {
    const t = await setup(channelRecord({ rules: { act_buttons: true } }));
    t.listeners.start();
    expect(t.sources).toHaveLength(1);
    expect(t.sources[0]?.handlers).toHaveLength(1);
    expect(t.listeners.status('nc-000000000001')?.state).toBe('connecting');
    t.sources[0]?.set('connected');
    expect(t.listeners.status('nc-000000000001')?.state).toBe('connected');
    expect(t.changed.length).toBeGreaterThanOrEqual(2);
    // A reload rebuilds the adapter: the old listener stops, the new one starts.
    await t.registry.reload();
    expect(t.sources[0]?.stops).toBe(1);
    expect(t.sources[1]?.handlers).toHaveLength(1);
    // Act buttons off: no listener.
    await t.repos.notificationChannels.upsert(channelRecord({ rules: {} }));
    await t.registry.reload();
    expect(t.sources[1]?.stops).toBe(1);
    expect(t.listeners.status('nc-000000000001')).toBeNull();
    t.listeners.stop();
  });

  it('never listens without act buttons, and stops everything on stop', async () => {
    const off = await setup(channelRecord());
    off.listeners.start();
    expect(off.sources).toHaveLength(0);
    const on = await setup(channelRecord({ rules: { act_buttons: true } }));
    on.listeners.start();
    on.listeners.stop();
    expect(on.sources[0]?.stops).toBe(1);
    on.sources[0]?.set('connected');
    expect(on.listeners.status('nc-000000000001')).toBeNull();
  });
});

describe('outbox minting', () => {
  async function deliver(rules: NotificationChannelRecord['rules'], withPresses: boolean) {
    const repos = new InMemoryRepositories();
    const uow = new InMemoryUnitOfWork(repos);
    const clock = new FakeClock();
    const ids = new FakeIdGenerator();
    const logger = new CollectingLogger();
    await repos.notificationChannels.upsert(channelRecord({ rules }));
    const fake = new FakeChannel('nc-000000000001', capabilities({ actButtons: true }));
    const adapter = withPresses ? Object.assign(fake, { presses: new FakeSource() }) : fake;
    const registry = new ChannelRegistry({
      repo: repos.notificationChannels,
      clock,
      ids,
      logger,
      factories: new Map([['fake', () => adapter]]),
    });
    await registry.load();
    const minted: string[] = [];
    const outbox = new NotificationOutbox({
      uow,
      repos,
      registry,
      links: createLocalLinkBuilder(() => 'http://127.0.0.1:9876'),
      clock,
      logger,
      actions: {
        async mint(channelId, message) {
          minted.push(channelId);
          return new Map(
            message.actions.filter((a) => a.kind === 'act').map((a) => [a.id, `bh1:${a.id}`]),
          );
        },
      },
    });
    const service = new NotificationService({
      repo: repos.notifications,
      bus: {
        publish: () => undefined,
        subscribe: () => () => undefined,
        subscribeAll: () => () => undefined,
      },
      clock,
      ids,
      logger,
      uow,
      outbox: { plan: (m, now) => outbox.plan(m, now), kick: () => undefined },
    });
    await service.produce(attentionCreated('a-000000000001', 'takeover'));
    await outbox.tick();
    return { minted, delivery: fake.ops('send')[0]?.delivery ?? null };
  }

  it('mints tokens before the call for a channel that receives presses', async () => {
    const { minted, delivery } = await deliver({ act_buttons: true }, true);
    expect(minted).toEqual(['nc-000000000001']);
    expect([...(delivery?.actTokens?.entries() ?? [])]).toEqual([
      ['resolve', 'bh1:resolve'],
      ['reject', 'bh1:reject'],
    ]);
  });

  it('mints nothing for a channel without a press listener', async () => {
    const { minted, delivery } = await deliver({}, false);
    expect(minted).toEqual([]);
    expect(delivery?.actTokens).toBeUndefined();
  });
});
