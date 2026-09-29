/** @module test/notifications/channel-service.test — the channels API service (spec 03 §4.8.1): views without secret values, CRUD and its refusals, read-only startup channels, pause/resume, the test send through a real adapter against the fakes, the pure preview, the delivery log and its cursor, the env check and the Telegram connect flow. */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import type { DomainEvents } from '../../src/app/events/catalog.ts';
import { ChannelRegistry } from '../../src/app/notifications/channel-registry.ts';
import { ChannelService, targetHint } from '../../src/app/notifications/channel-service.ts';
import { createPublicLinkBuilder } from '../../src/app/notifications/links.ts';
import { CHANNEL_RENDERERS, channelFactories } from '../../src/infra/notifications/index.ts';
import { AppError } from '../../src/kernel/errors/app-error.ts';
import type { TelegramSetup } from '../../src/ports/notification-channel.ts';
import { CollectingLogger } from '../helpers/collecting-logger.ts';
import { FakeClock } from '../helpers/fake-clock.ts';
import { FakeIdGenerator } from '../helpers/fake-id-generator.ts';
import { FakePlatforms } from '../helpers/fake-platforms.ts';
import { InMemoryRepositories, InMemoryUnitOfWork } from '../helpers/in-memory-repos.ts';
import { RecordingEventBus } from '../helpers/recording-event-bus.ts';

const fakes = new FakePlatforms();
beforeAll(() => fakes.start());
afterAll(() => fakes.stop());

const ENV: Record<string, string> = {
  BH_TELEGRAM_TOKEN: `1234:${'a'.repeat(35)}`,
  BH_HOOK_SECRET: 'h'.repeat(32),
};

interface Kit {
  readonly service: ChannelService;
  readonly registry: ChannelRegistry;
  readonly repos: InMemoryRepositories;
  readonly bus: RecordingEventBus<DomainEvents>;
  readonly clock: FakeClock;
  readonly started: string[];
}

async function kit(options: { readonly startup?: boolean } = {}): Promise<Kit> {
  const repos = new InMemoryRepositories();
  const clock = new FakeClock();
  const ids = new FakeIdGenerator();
  const logger = new CollectingLogger();
  const bus = new RecordingEventBus<DomainEvents>();
  const registry = new ChannelRegistry({
    repo: repos.notificationChannels,
    clock,
    ids,
    logger,
    env: (name) => ENV[name],
    factories: channelFactories({ images: { read: async () => null } }),
  });
  await registry.load(
    options.startup === true
      ? [
          {
            name: 'boot',
            kind: 'ntfy',
            mode: null,
            target: { server: fakes.ntfyServer, topic: 'bh-boot' },
            secret_refs: {},
            rules: {},
          },
        ]
      : [],
  );
  const started: string[] = [];
  const telegram: TelegramSetup = {
    botUsername: async () => 'bh_test_bot',
    waitForStart: async (_token, code) => {
      started.push(code);
      return {
        chat: { id: '-1001234', title: 'Ops', type: 'supergroup', threadId: null },
        user: { id: '42', name: 'Amir' },
      };
    },
  };
  const service = new ChannelService({
    repos,
    uow: new InMemoryUnitOfWork(repos),
    registry,
    renderers: CHANNEL_RENDERERS,
    links: createPublicLinkBuilder('https://bh.example.net'),
    clock,
    ids,
    logger,
    bus,
    env: (name) => ENV[name],
    telegram,
    schedule: () => undefined,
  });
  return { service, registry, repos, bus, clock, started };
}

const code = (fn: () => unknown) => {
  try {
    fn();
  } catch (err) {
    return err instanceof AppError ? err.code : 'other';
  }
  return 'none';
};
const codeOf = async (promise: Promise<unknown>) => {
  try {
    await promise;
  } catch (err) {
    return err instanceof AppError ? err.code : 'other';
  }
  return 'none';
};

beforeEach(() => {
  fakes.requests.length = 0;
});

describe('ChannelService writes', () => {
  it('creates a channel whose view names variables but never holds a value', async () => {
    const { service, bus } = await kit();
    const view = await service.create({
      name: 'phone',
      kind: 'telegram',
      target: { chat_id: '-1001234567890', chat_title: 'Ops' },
      secret_refs: { token: 'BH_TELEGRAM_TOKEN' },
      rules: {},
    });
    expect(view).toMatchObject({
      name: 'phone',
      source: 'db',
      status: 'active',
      ready: true,
      problem: null,
      target_hint: 'Ops (…7890)',
      secrets: [{ param: 'token', env: 'BH_TELEGRAM_TOKEN', set: true }],
    });
    expect(JSON.stringify(view)).not.toContain('aaaa');
    expect(bus.published.some((e) => e.name === 'channel.changed')).toBe(true);
  });

  it('reports a missing variable as the problem and refuses a test send', async () => {
    const { service } = await kit();
    const view = await service.create({
      name: 'team',
      kind: 'discord',
      target: {},
      secret_refs: { webhook: 'BH_UNSET_WEBHOOK' },
      rules: {},
    });
    expect(view.ready).toBe(false);
    expect(view.problem).toContain('BH_UNSET_WEBHOOK');
    expect(await codeOf(service.test(view.channel_id))).toBe('CHANNEL_NOT_READY');
  });

  it('refuses secret values, reserved names, Telegram TTLs above 47 h, bot mode and taken names', async () => {
    const { service } = await kit();
    const base = { name: 'x', kind: 'telegram' as const, target: { chat_id: '1' } };
    expect(
      await codeOf(service.create({ ...base, secret_refs: { token: '123:abc' }, rules: {} })),
    ).toBe('VALIDATION_FAILED');
    expect(
      await codeOf(
        service.create({ ...base, secret_refs: { token: 'BROWSERHIVE_TOKEN' }, rules: {} }),
      ),
    ).toBe('VALIDATION_FAILED');
    expect(
      await codeOf(
        service.create({
          ...base,
          secret_refs: { token: 'BH_TELEGRAM_TOKEN' },
          rules: { ttl_ms: { 'needs-you': 48 * 3600_000 } },
        }),
      ),
    ).toBe('VALIDATION_FAILED');
    expect(
      await codeOf(
        service.create({
          name: 'bot',
          kind: 'discord',
          mode: 'bot',
          target: {},
          secret_refs: { webhook: 'BH_W' },
          rules: {},
        }),
      ),
    ).toBe('VALIDATION_FAILED');
    // Act buttons need a platform that receives presses; allow-lists take numeric ids.
    expect(
      await codeOf(
        service.create({
          name: 'hooky',
          kind: 'discord',
          target: {},
          secret_refs: { webhook: 'BH_W' },
          rules: { act_buttons: true },
        }),
      ),
    ).toBe('VALIDATION_FAILED');
    expect(
      await codeOf(
        service.create({
          ...base,
          secret_refs: { token: 'BH_TELEGRAM_TOKEN' },
          rules: { act_buttons: true, allow_list: ['me'] },
        }),
      ),
    ).toBe('VALIDATION_FAILED');
    expect(
      await codeOf(
        service.create({
          name: 'shots',
          kind: 'ntfy',
          target: { topic: 't' },
          secret_refs: {},
          rules: { images: { 'needs-you': true } },
        }),
      ),
    ).toBe('VALIDATION_FAILED');
    await service.create({
      name: 'dup',
      kind: 'ntfy',
      target: { topic: 't' },
      secret_refs: {},
      rules: {},
    });
    expect(
      await codeOf(
        service.create({
          name: 'dup',
          kind: 'ntfy',
          target: { topic: 'u' },
          secret_refs: {},
          rules: {},
        }),
      ),
    ).toBe('CHANNEL_NAME_TAKEN');
  });

  it('keeps startup channels read-only but lets them pause and resume', async () => {
    const { service, registry } = await kit({ startup: true });
    const boot = registry.channels()[0]?.record.channelId ?? '';
    expect(await codeOf(service.update(boot, { rules: {} }))).toBe('CHANNEL_READ_ONLY');
    expect(await codeOf(service.remove(boot))).toBe('CHANNEL_READ_ONLY');
    expect((await service.pause(boot)).status).toBe('paused');
    expect((await service.resume(boot)).status).toBe('active');
  });

  it('edits and deletes a dashboard channel', async () => {
    const { service, registry } = await kit();
    const view = await service.create({
      name: 'pager',
      kind: 'ntfy',
      target: { server: fakes.ntfyServer, topic: 'bh-a' },
      secret_refs: {},
      rules: {},
    });
    const edited = await service.update(view.channel_id, {
      name: 'pager-2',
      rules: { min_severity: 'error' },
    });
    expect(edited).toMatchObject({ name: 'pager-2', rules: { min_severity: 'error' } });
    await service.remove(view.channel_id);
    expect(registry.channels()).toHaveLength(0);
    expect(code(() => service.preview({ channel_id: view.channel_id, sample: 'test' }))).toBe(
      'CHANNEL_NOT_FOUND',
    );
  });
});

describe('ChannelService test send, preview and the delivery log', () => {
  it('sends a real test message and records it in the log', async () => {
    const { service, bus } = await kit();
    const view = await service.create({
      name: 'hook',
      kind: 'webhook',
      target: { url: fakes.webhookUrl },
      secret_refs: { secret: 'BH_HOOK_SECRET' },
      rules: {},
    });
    const result = await service.test(view.channel_id);
    expect(result.ok).toBe(true);
    expect(result.delivery).toMatchObject({
      status: 'sent',
      reason: 'test',
      notification_kind: 'test',
      channel_name: 'hook',
    });
    const [post] = fakes.of('webhook');
    const body = post?.json as { message: { title: string }; links: Record<string, string> };
    expect(body.message.title).toBe('BrowserHive test message');
    expect(body.links['open-dashboard']).toBe('https://bh.example.net/notifications/channels');
    expect(bus.published.some((e) => e.name === 'delivery.updated')).toBe(true);
    const page = await service.deliveries({ limit: 10 });
    expect(page.items.map((d) => d.status)).toEqual(['sent']);
  });

  it('reports a platform refusal as a failed test, dead in the log', async () => {
    const { service } = await kit();
    fakes.script('webhook', { status: 401, body: { error: 'no' } });
    const view = await service.create({
      name: 'hook',
      kind: 'webhook',
      target: { url: fakes.webhookUrl },
      secret_refs: {},
      rules: {},
    });
    const result = await service.test(view.channel_id);
    expect(result).toMatchObject({ ok: false, error: { code: 'auth' } });
    expect(result.delivery).toMatchObject({ status: 'dead', reason: 'auth' });
  });

  it('previews a draft and a saved channel with variable names in place of secrets', async () => {
    const { service } = await kit();
    const draft = service.preview({ kind: 'discord', sample: 'attention' });
    expect(draft.requests[0]?.path).toContain('{BH_DISCORD_WEBHOOK}');
    expect(draft.notes.some((n) => n.includes('Approve and Reject open BrowserHive'))).toBe(true);
    const saved = await service.create({
      name: 'pager',
      kind: 'ntfy',
      target: { server: 'https://ntfy.example.net' },
      secret_refs: { topic: 'BH_TOPIC_VAR' },
      rules: { content: 'full', images: { 'needs-you': true } },
    });
    const preview = service.preview({ channel_id: saved.channel_id, sample: 'attention' });
    expect(JSON.stringify(preview.requests)).toContain('{BH_TOPIC_VAR}');
    expect(preview.requests[0]?.file).toEqual({
      name: 'screenshot.jpg',
      content_type: 'image/jpeg',
    });
    expect(preview.message.privacy.has_image).toBe(true);
    const bot = service.preview({
      kind: 'discord',
      mode: 'bot',
      target: { channel_id: '112233445566778899' },
      rules: { act_buttons: true },
      sample: 'attention',
    });
    expect(bot.capabilities.act_buttons).toBe(true);
    expect(JSON.stringify(bot.requests)).toContain('bh1:preview-reject');
    expect(bot.notes.some((n) => n.includes('allow-list'))).toBe(true);
    // A draft's ntfy reply topic from a variable enables the answer buttons; a pasted value is ignored.
    const ntfy = service.preview({
      kind: 'ntfy',
      target: { topic: 'bh-alerts' },
      secret_refs: { reply_topic: 'BH_REPLY', token: 'tk_pasted value' },
      rules: { act_buttons: true },
      sample: 'attention',
    });
    expect(ntfy.capabilities.act_buttons).toBe(true);
    expect(JSON.stringify(ntfy.requests)).toContain('{BH_REPLY}');
    expect(JSON.stringify(ntfy.requests)).not.toContain('tk_pasted');
    expect(
      targetHint({
        kind: 'discord',
        mode: 'bot',
        target: { channel_id: '112233445566778899', channel_name: 'alerts', guild_name: 'Home' },
        secretRefs: { token: 'BH_BOT' },
      }),
    ).toBe('bot · #alerts in Home');
    const off = service.preview({ kind: 'discord', mode: 'bot', sample: 'attention' });
    expect(off.capabilities.act_buttons).toBe(false);
    expect(fakes.requests).toHaveLength(0);
  });

  it('pages the log newest first with an opaque cursor', async () => {
    const { service } = await kit();
    const view = await service.create({
      name: 'hook',
      kind: 'webhook',
      target: { url: fakes.webhookUrl },
      secret_refs: {},
      rules: {},
    });
    for (let i = 0; i < 3; i++) await service.test(view.channel_id);
    const first = await service.deliveries({ limit: 2 });
    expect(first.items.map((d) => d.seq)).toEqual([3, 2]);
    expect(first.nextCursor).not.toBeNull();
    const second = await service.deliveries({ limit: 2, cursor: first.nextCursor ?? '' });
    expect(second.items.map((d) => d.seq)).toEqual([1]);
    expect(second.nextCursor).toBeNull();
    const detail = await service.delivery(1);
    expect(detail.message?.kind).toBe('test');
    expect(await codeOf(service.delivery(99))).toBe('DELIVERY_NOT_FOUND');
    expect(await codeOf(service.deliveries({ limit: 2, cursor: 'bm9wZQ' }))).toBe(
      'VALIDATION_FAILED',
    );
  });
});

describe('ChannelService env check and Telegram connect', () => {
  it('says whether variables are set, never what they hold', async () => {
    const { service } = await kit();
    expect(service.env(['BH_TELEGRAM_TOKEN', 'BH_NOPE'])).toEqual([
      { name: 'BH_TELEGRAM_TOKEN', set: true },
      { name: 'BH_NOPE', set: false },
    ]);
  });

  it('builds the one-tap links and captures the chat and the person who connected it', async () => {
    const { service, started } = await kit();
    const start = await service.telegramConnect('BH_TELEGRAM_TOKEN');
    expect(start.bot_username).toBe('bh_test_bot');
    expect(start.link).toBe(`https://t.me/bh_test_bot?start=${started[0]}`);
    expect(start.group_link).toContain('startgroup=');
    await Promise.resolve();
    await Promise.resolve();
    expect(service.telegramConnectStatus(start.connect_id)).toMatchObject({
      status: 'connected',
      chat: { id: '-1001234', title: 'Ops', type: 'supergroup' },
      user: { id: '42', name: 'Amir' },
    });
    expect(await codeOf(service.telegramConnect('BH_NOPE'))).toBe('CHANNEL_NOT_READY');
    expect(code(() => service.telegramConnectStatus('unknownid1'))).toBe('NOT_FOUND');
  });
});
