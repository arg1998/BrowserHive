/** @module app/templates/relogin-act.test — the `template.relogin` act button through a test channel (spec 13 §8.4, §8.6, D-41; review #81 M-4): the sign-out notification carries the button, a press from the channel's allowed chat user queues the re-login (never opens a window), the presser is recorded on the audit rows, and a second press is refused as used. */

import { describe, expect, it } from 'bun:test';
import { TemplateHealthEvent } from '@browserhive/contracts/ws';
import { CollectingLogger } from '../../../test/helpers/collecting-logger.ts';
import { capabilities, channelRecord, FakeChannel } from '../../../test/helpers/fake-channel.ts';
import { FakeClock } from '../../../test/helpers/fake-clock.ts';
import { FakeIdGenerator } from '../../../test/helpers/fake-id-generator.ts';
import { InMemoryRepositories, InMemoryUnitOfWork } from '../../../test/helpers/in-memory-repos.ts';
import { InMemoryOperatorActionRepository } from '../../../test/helpers/in-memory-vault-repos.ts';
import { RecordingEventBus } from '../../../test/helpers/recording-event-bus.ts';
import { templateRecord, templateSiteRecord } from '../../../test/persistence/helpers.ts';
import type { DomainEvents } from '../events/catalog.ts';
import { NotificationActionService } from '../notifications/actions.ts';
import { ChannelRegistry } from '../notifications/channel-registry.ts';
import { decodeMessage } from '../notifications/message.ts';
import { NotificationService } from '../notifications/notification-service.ts';
import { reloginActionExecutor } from './relogin-executor.ts';
import { TemplatePause } from './template-pause.ts';
import { TemplateReloginService } from './template-relogin.ts';
import { toSiteView } from './views.ts';

const CHAT = '-1001';
const SITE = 'site-a.test';

describe('the template.relogin act button (D-41)', () => {
  it('a press from the chat queues the re-login as the presser; the window opens only on Show window', async () => {
    const clock = new FakeClock();
    const repos = new InMemoryRepositories();
    const operatorActions = new InMemoryOperatorActionRepository();
    const bus = new RecordingEventBus<DomainEvents>();
    const logger = new CollectingLogger();
    const ids = new FakeIdGenerator();
    const template = templateRecord({ status: 'ready' });
    await repos.templates.insert(template);
    const site = templateSiteRecord({ siteId: SITE, learnedCookieNames: ['sid'] });
    await repos.templateSites.upsert(site);
    const windows: string[] = [];
    const relogin = new TemplateReloginService({
      repos: { ...repos, operatorActions },
      supervisor: {
        pause: new TemplatePause({ clock, alive: () => false }),
        launchMaintenance: async () => {
          throw new Error('unused');
        },
        host: () => ({ state: 'running' }) as never,
      },
      ops: {
        openSignInWindow: async () => {
          windows.push('opened');
          throw new Error('no window in this test');
        },
        raiseWindow: async () => undefined,
        recordingOf: () => null,
        jar: async () => [],
        held: () => false,
      },
      sessions: { close: async () => true as never, peek: () => undefined },
      health: { record: async () => undefined, probe: async () => [] },
      ids,
      clock,
      logger,
      machine: 'hive-box',
    });

    const record = channelRecord({
      kind: 'telegram',
      target: { chat_id: CHAT },
      rules: { act_buttons: true, allow_list: ['42'] },
    });
    await repos.notificationChannels.upsert(record);
    const fake = new FakeChannel(
      record.channelId,
      capabilities({ actButtons: true }),
      'phone',
      'telegram',
    );
    const registry = new ChannelRegistry({
      repo: repos.notificationChannels,
      clock,
      ids,
      logger,
      factories: new Map([['telegram', () => fake]]),
    });
    await registry.load();
    const actions = new NotificationActionService({
      repos,
      registry,
      clock,
      ids,
      logger,
      executors: new Map([['template.relogin', reloginActionExecutor(relogin)]]),
      bus,
    });
    const notifications = new NotificationService({
      repo: repos.notifications,
      bus,
      clock,
      ids,
      logger,
      uow: new InMemoryUnitOfWork(repos),
    });
    const signedOut = {
      ...site,
      health: { ...site.health, state: 'signed_out' as const, reason: 'cookies_absent' },
    };
    const base = TemplateHealthEvent.parse({
      type: 'template.health',
      template_id: template.templateId,
      site: toSiteView(signedOut),
    });
    await notifications.produce({
      name: 'template.health',
      at: clock.now(),
      payload: {
        ...base,
        transition: {
          template: { name: template.name, display_name: template.displayName },
          provider: SITE,
          covers: [SITE],
          from: 'signed_in',
          to: 'signed_out',
          reason: 'cookies_absent',
          provider_signed_in: false,
          machine: 'hive-box',
          at: clock.now(),
        },
      },
    });
    const row = [...repos.notifications.rows.values()][0];
    const message = decodeMessage(row?.messageJson ?? null);
    if (message === null) throw new Error('no notification');
    expect(message.kind).toBe('template.signed_out');
    const tokens = await actions.mint(record.channelId, message, clock.now());
    const token = (tokens.get('relogin') ?? '').slice('bh1:'.length);
    expect(token.length).toBeGreaterThan(0);

    const press = () =>
      actions.press({
        token,
        origin: CHAT,
        actor: { platform: 'telegram', id: '42', name: 'Amir' },
      });
    const answer = await press();
    expect(answer.outcome).toBe('done');
    expect(answer.text).toContain('Queued');
    expect(relogin.view(template.templateId)).toMatchObject({
      state: 'queued',
      method: 'window',
      requested_by: 'telegram:42',
      session_id: null,
    });
    expect(windows).toEqual([]);
    const audit = operatorActions.rows.find((r) => r.action === 'template.relogin');
    expect(audit).toMatchObject({
      principalId: 'telegram:42',
      details: { site_id: SITE, queued: true, presser: 'telegram:42' },
    });
    expect((await press()).outcome).toBe('used');
  });
});
