/** @module app/notifications/producers-lifecycle.test — template notification lifecycles past the first revision (spec 13 §8.6): sign-out and challenge threads go `final` when their site or template is removed (D34), a session's challenge links to its takeover (D45), and an open write confirmation resolves at startup once its request is settled (D46). */

import { describe, expect, it } from 'bun:test';
import type { TemplateSiteView, TemplateSummary } from '@browserhive/contracts/http';
import { NotificationMessage } from '@browserhive/contracts/notifications';
import { TemplateHealthEvent } from '@browserhive/contracts/ws';
import { CollectingLogger } from '../../../test/helpers/collecting-logger.ts';
import { FakeClock } from '../../../test/helpers/fake-clock.ts';
import { FakeIdGenerator } from '../../../test/helpers/fake-id-generator.ts';
import { InMemoryNotificationRepository } from '../../../test/helpers/in-memory-repos.ts';
import { RecordingEventBus } from '../../../test/helpers/recording-event-bus.ts';
import type { SiteConfirmEvent } from '../../ports/site-guards.ts';
import type { DomainEvents, SigninTransition } from '../events/catalog.ts';
import { NotificationService } from './notification-service.ts';
import type { ProducedEvent } from './producers.ts';
import { signinDraft } from './producers-templates.ts';

const TID = 'tp-fixture001';
const OTHER = 'tp-fixture002';
const AT = 1_700_000_100_000;

function siteView(siteId: string): TemplateSiteView {
  return {
    site_id: siteId,
    title: siteId,
    pack_id: null,
    pack_version: null,
    enabled: true,
    write_policy: null,
    vault_handle: null,
    auto_relogin: false,
    auto_relogin_at: null,
    form: null,
    learned_cookie_names: ['sid'],
    health: {
      state: 'signed_out',
      checked_at: AT,
      changed_at: AT,
      reason: 'cookies_absent',
      consecutive_inconclusive: 0,
    },
    stopped_at: null,
    device_bound: false,
    added_at: 1,
    pack: null,
    strategy_notes: [],
  };
}

function signedOut(
  provider: string,
  templateId = TID,
  patch: Partial<SigninTransition> = {},
): ProducedEvent {
  const base = TemplateHealthEvent.parse({
    type: 'template.health',
    template_id: templateId,
    site: siteView(provider),
  });
  const transition: SigninTransition = {
    template: { name: 'job-hunt', display_name: 'Job hunt' },
    provider,
    covers: [provider],
    from: 'signed_in',
    to: 'signed_out',
    reason: 'cookies_absent',
    provider_signed_in: false,
    machine: 'studio-mac',
    at: AT,
    ...patch,
  };
  return { name: 'template.health', at: 1, payload: { ...base, transition } };
}

function summary(templateId: string): TemplateSummary {
  return {
    template_id: templateId,
    name: 'job-hunt',
    display_name: 'Job hunt',
    status: 'ready',
    channel: 'chromium',
    headless: true,
    sites: [],
    host: { state: 'stopped', since: null, pages: 0 },
    in_use: 0,
    cap: 4,
    current_version: 1,
    checkpoint_at: null,
    last_used_at: null,
    sealed: true,
  };
}

function changed(providers: readonly string[], at: number, templateId = TID): ProducedEvent {
  return {
    name: 'template.changed',
    at: 1,
    payload: {
      type: 'template.changed',
      template: summary(templateId),
      providers: { ids: providers, at },
    },
  };
}

function setup() {
  const repo = new InMemoryNotificationRepository();
  const service = new NotificationService({
    repo,
    bus: new RecordingEventBus<DomainEvents>(),
    clock: new FakeClock(),
    ids: new FakeIdGenerator(),
    logger: new CollectingLogger(),
  });
  return { repo, service };
}

function stateOf(repo: InMemoryNotificationRepository, id: string | undefined) {
  return repo.rows.get(id ?? '')?.state;
}

describe('D34: sign-in threads go final when their site or template is removed', () => {
  it('removing a site finalizes only the threads of providers no site uses any more', async () => {
    const { repo, service } = setup();
    const [a] = await service.produce(signedOut('site-a.test'));
    const [b] = await service.produce(signedOut('site-b.test'));
    const [elsewhere] = await service.produce(signedOut('site-a.test', OTHER));
    const [challenged] = await service.produce(signedOut('site-c.test', TID, { to: 'challenged' }));
    // site-a.test was removed: site-b.test and site-c.test remain.
    const revised = await service.produce(changed(['site-b.test', 'site-c.test'], AT + 1));
    expect(revised.map((n) => String(n.notification_id))).toEqual([String(a?.notification_id)]);
    expect(stateOf(repo, a?.notification_id)).toBe('final');
    expect(stateOf(repo, b?.notification_id)).toBe('open');
    expect(stateOf(repo, challenged?.notification_id)).toBe('open');
    expect(stateOf(repo, elsewhere?.notification_id)).toBe('open');
    const message = NotificationMessage.parse(
      JSON.parse(repo.rows.get(a?.notification_id ?? '')?.messageJson ?? 'null'),
    );
    expect(message).toMatchObject({ state: 'final', actions: [] });
    expect(message.summary).toContain('no longer part of this template');
    // An unrelated change that keeps every provider revises nothing.
    expect(await service.produce(changed(['site-b.test', 'site-c.test'], AT + 2))).toEqual([]);
  });

  it('a template whose id prefixes another one leaves the other alone', async () => {
    const { repo, service } = setup();
    const [mine] = await service.produce(signedOut('site-a.test', 'tp-a'));
    const [longer] = await service.produce(signedOut('site-a.test', 'tp-ab'));
    await service.produce(changed([], AT + 1, 'tp-a'));
    expect(stateOf(repo, mine?.notification_id)).toBe('final');
    expect(stateOf(repo, longer?.notification_id)).toBe('open');
  });

  it('deleting the template finalizes its sign-out and challenge threads', async () => {
    const { repo, service } = setup();
    const [a] = await service.produce(signedOut('site-a.test'));
    const [c] = await service.produce(signedOut('site-c.test', TID, { to: 'challenged' }));
    const [elsewhere] = await service.produce(signedOut('site-a.test', OTHER));
    const removed: ProducedEvent = {
      name: 'template.removed',
      at: 1,
      payload: { type: 'template.removed', template_id: TID },
    };
    expect(await service.produce(removed)).toHaveLength(2);
    expect(stateOf(repo, a?.notification_id)).toBe('final');
    expect(stateOf(repo, c?.notification_id)).toBe('final');
    expect(stateOf(repo, elsewhere?.notification_id)).toBe('open');
    // A new sign-out of the provider (the same id cannot come back, but the thread is free again).
    expect(await service.produce(signedOut('site-a.test', TID, { at: AT + 5 }))).toHaveLength(1);
  });
});

describe("D45: a session's challenge links to its takeover", () => {
  it('a challenge that opened a takeover on an agent session adds Take over for it', () => {
    const event = signedOut('site-a.test', TID, {
      to: 'challenged',
      session_id: 'demo-00000001',
      session_takeover: true,
    });
    if (event.name !== 'template.health') throw new Error('unreachable');
    const draft = signinDraft(event.payload);
    expect(draft?.sessionId).toBe('demo-00000001');
    const content = draft?.content(1);
    expect(content?.actions).toEqual([
      expect.objectContaining({
        id: 'take-over',
        style: 'primary',
        path: '/sessions/demo-00000001?live=1&takeover=1',
      }),
      expect.objectContaining({ id: 'open-template', style: 'default' }),
    ]);
    expect(content?.entities).toMatchObject({ session_id: 'demo-00000001' });
  });

  it('a notify challenge opened no takeover: Watch live, the template stays primary (review #93 M1)', () => {
    const event = signedOut('site-a.test', TID, {
      to: 'challenged',
      session_id: 'demo-00000001',
      session_takeover: false,
    });
    if (event.name !== 'template.health') throw new Error('unreachable');
    expect(signinDraft(event.payload)?.content(1).actions).toEqual([
      expect.objectContaining({
        id: 'watch-live',
        style: 'default',
        path: '/sessions/demo-00000001?live=1',
      }),
      expect.objectContaining({ id: 'open-template', style: 'primary' }),
    ]);
  });

  it('a probe challenge and a sign-out have no takeover action', () => {
    for (const patch of [{ to: 'challenged' as const }, { session_id: 'demo-00000001' }]) {
      const event = signedOut('site-a.test', TID, patch);
      if (event.name !== 'template.health') throw new Error('unreachable');
      const draft = signinDraft(event.payload);
      expect(draft?.content(1).actions.some((a) => a.id === 'take-over')).toBe(false);
      expect(draft?.sessionId).toBeNull();
    }
  });
});

describe('D46: write confirmations resolve after a restart', () => {
  function confirm(requestId: string, site: string): ProducedEvent {
    const payload: SiteConfirmEvent = {
      type: 'site_pack.confirm',
      phase: 'opened',
      template_id: TID,
      template_name: 'Job Hunt',
      site,
      site_title: site,
      open: 1,
      request_id: requestId,
      session_id: 'demo-00000001',
      guard: { pack_id: site, id: 'invite', kind: 'write' },
      method: 'POST',
      url: `https://www.${site}/api/invite`,
      tool: null,
      at: AT,
    };
    return { name: 'site_pack.confirm', at: 1, payload };
  }

  const facts = (status: 'pending' | 'rejected') => ({
    status,
    resolvedBy: null,
    createdAt: AT,
    resolvedAt: status === 'pending' ? null : AT + 1,
    waitedMs: null,
  });

  it('a thread whose request the orphan recovery settled resolves; a pending one stays', async () => {
    const { repo, service } = setup();
    const [settled] = await service.produce(confirm('a-000000000001', 'site-a.test'));
    const [pending] = await service.produce(confirm('a-000000000002', 'site-b.test'));
    const [gone] = await service.produce(confirm('a-000000000003', 'site-c.test'));
    const requests = new Map([
      ['a-000000000001', facts('rejected')],
      ['a-000000000002', facts('pending')],
    ]);
    const get = async (id: string) => requests.get(id) ?? null;
    expect(await service.reconcileRequests({ get })).toBe(2);
    expect(stateOf(repo, settled?.notification_id)).toBe('resolved');
    expect(stateOf(repo, gone?.notification_id)).toBe('resolved');
    expect(stateOf(repo, pending?.notification_id)).toBe('open');
    const message = NotificationMessage.parse(
      JSON.parse(repo.rows.get(settled?.notification_id ?? '')?.messageJson ?? 'null'),
    );
    expect(message).toMatchObject({ state: 'resolved', actions: [] });
    // The next start leaves resolved rows alone.
    expect(await service.reconcileRequests({ get })).toBe(0);
  });
});
