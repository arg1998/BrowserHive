/** @module app/notifications/channel-registry.test — startup channels projected read-only into the table (D-39), removal of undeclared ones, the name clash, adapter factories and secret resolution (D-33). */

import { describe, expect, it } from 'bun:test';
import type { StartupNotificationChannel } from '@browserhive/contracts/notifications';
import { CollectingLogger } from '../../../test/helpers/collecting-logger.ts';
import { channelRecord, FakeChannel } from '../../../test/helpers/fake-channel.ts';
import { FakeClock } from '../../../test/helpers/fake-clock.ts';
import { FakeIdGenerator } from '../../../test/helpers/fake-id-generator.ts';
import { InMemoryRepositories } from '../../../test/helpers/in-memory-repos.ts';
import { AppError } from '../../kernel/errors/app-error.ts';
import {
  type ChannelAdapterFactory,
  ChannelRegistry,
  type ChannelRegistryDeps,
} from './channel-registry.ts';

const STARTUP: StartupNotificationChannel = {
  name: 'pager',
  kind: 'telegram',
  mode: null,
  target: { chat: '42' },
  secret_refs: { token: 'BH_TG_TOKEN' },
  rules: { categories: ['needs-you'] },
};

function setup(extra: Partial<ChannelRegistryDeps> = {}) {
  const repos = new InMemoryRepositories();
  const clock = new FakeClock();
  const registry = new ChannelRegistry({
    repo: repos.notificationChannels,
    clock,
    ids: new FakeIdGenerator(),
    logger: new CollectingLogger(),
    ...extra,
  });
  return { repos, clock, registry };
}

describe('ChannelRegistry', () => {
  it('is empty and costs nothing without channels', async () => {
    const { registry } = setup();
    await registry.load();
    expect(registry.hasChannels()).toBe(false);
    expect(registry.channels()).toEqual([]);
  });

  it('projects startup channels as read-only rows and keeps their breaker state across starts', async () => {
    const { repos, registry, clock } = setup();
    await registry.load([STARTUP]);
    const [row] = await repos.notificationChannels.list();
    expect(row).toMatchObject({
      name: 'pager',
      kind: 'telegram',
      source: 'startup',
      status: 'active',
      secretRefs: { token: 'BH_TG_TOKEN' },
      rules: { categories: ['needs-you'] },
    });
    if (row === undefined) throw new Error('no row');
    await repos.notificationChannels.recordFailure(row.channelId, 5, 'down');
    await repos.notificationChannels.setStatus(row.channelId, 'paused', 6);
    await clock.advance(1_000);
    await registry.load([{ ...STARTUP, rules: { categories: ['problems'] } }]);
    const [again] = await repos.notificationChannels.list();
    expect(again).toMatchObject({
      channelId: row.channelId,
      status: 'paused',
      failureCount: 1,
      rules: { categories: ['problems'] },
      createdAt: row.createdAt,
      updatedAt: clock.now(),
    });
  });

  it('removes startup channels that are no longer declared, with their delivery log', async () => {
    const { repos, registry } = setup();
    await registry.load([STARTUP]);
    const [row] = await repos.notificationChannels.list();
    await repos.notificationDeliveries.enqueue([
      {
        channelId: row?.channelId ?? '',
        notificationId: 'n-000000000001',
        revision: 1,
        op: 'send',
        status: 'pending',
        reason: null,
        nextAttemptAt: 1,
        createdAt: 1,
      },
    ]);
    await repos.notificationChannels.upsert(channelRecord({ channelId: 'nc-db', name: 'team' }));
    await registry.load([]);
    expect((await repos.notificationChannels.list()).map((c) => c.name)).toEqual(['team']);
    expect(repos.notificationDeliveries.rows).toEqual([]);
  });

  it('refuses a startup channel whose name a dashboard channel uses', async () => {
    const { repos, registry } = setup();
    await repos.notificationChannels.upsert(channelRecord({ name: 'pager' }));
    const err = await registry.load([STARTUP]).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).code).toBe('CONFIG_INVALID');
    expect((err as AppError).message).toBe(
      "notification channel 'pager' is defined by --notificationChannel and in the dashboard. Rename one of them.",
    );
  });

  it('builds adapters through the factory of their kind, resolving and registering secrets by name', async () => {
    const registered: string[] = [];
    const seen: (string | null)[] = [];
    const fake = new FakeChannel();
    const { repos, registry } = setup({
      env: (name) => ({ BH_FAKE_TOKEN: 'a'.repeat(32), EMPTY: '' })[name],
      registerSecret: (v) => void registered.push(v),
      factories: new Map<string, ChannelAdapterFactory>([
        [
          'fake',
          (_row, ctx) => {
            seen.push(ctx.secret('BH_FAKE_TOKEN'), ctx.secret('EMPTY'), ctx.secret('UNSET'));
            return fake;
          },
        ],
        [
          'broken',
          () => {
            throw new Error('bad target');
          },
        ],
      ]),
    });
    await repos.notificationChannels.upsert(channelRecord());
    await repos.notificationChannels.upsert(
      channelRecord({ channelId: 'nc-2', name: 'b', kind: 'broken' }),
    );
    await repos.notificationChannels.upsert(
      channelRecord({ channelId: 'nc-3', name: 'c', kind: 'nothing' }),
    );
    let changes = 0;
    registry.onChange(() => {
      changes++;
    });
    await registry.load();
    expect(changes).toBe(1);
    expect(seen).toEqual(['a'.repeat(32), null, null]);
    expect(registered).toEqual(['a'.repeat(32)]);
    expect(registry.get('nc-000000000001')?.adapter).toBe(fake);
    expect(registry.get('nc-000000000001')?.capabilities).toBe(fake.capabilities);
    expect(registry.get('nc-2')?.adapter).toBeNull();
    expect(registry.get('nc-3')?.capabilities).toBeNull();
    registry.setCachedStatus('nc-000000000001', 'broken', 5);
    expect(registry.get('nc-000000000001')?.record).toMatchObject({
      status: 'broken',
      failureCount: 5,
    });
  });
});
