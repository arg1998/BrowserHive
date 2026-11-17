/** @module app/notifications/producers-templates.test — the session-template producer rules (spec 13 §8.6): the pure drafts and revisions, and through `NotificationService` one `template.signed_out` per identity provider that resolves itself, failed re-logins, failed browsers, contract validity and the redaction sentinel. */

import { describe, expect, it } from 'bun:test';
import type { HostView, TemplateSiteView } from '@browserhive/contracts/http';
import { NotificationMessage } from '@browserhive/contracts/notifications';
import { TemplateHealthEvent, TemplateHostEvent } from '@browserhive/contracts/ws';
import { CollectingLogger } from '../../../test/helpers/collecting-logger.ts';
import { FakeClock } from '../../../test/helpers/fake-clock.ts';
import { FakeIdGenerator } from '../../../test/helpers/fake-id-generator.ts';
import { reloginView } from '../../../test/helpers/fake-template-health.ts';
import { InMemoryNotificationRepository } from '../../../test/helpers/in-memory-repos.ts';
import { RecordingEventBus } from '../../../test/helpers/recording-event-bus.ts';
import { createRedactor, SecretRegistry } from '../../kernel/redact.ts';
import type { DomainEvents, SigninTransition } from '../events/catalog.ts';
import { NotificationService } from './notification-service.ts';
import type { ProducedEvent } from './producers.ts';
import {
  hostFailedDraft,
  hostRevision,
  hostThread,
  providerThread,
  reloginFailedDraft,
  signinDraft,
  signinRevision,
} from './producers-templates.ts';

const TID = 'tp-fixture001';
const AT = 1_700_000_100_000;

function siteView(siteId = 'site-a.test'): TemplateSiteView {
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

function transition(patch: Partial<SigninTransition> = {}): SigninTransition {
  return {
    template: { name: 'job-hunt', display_name: 'Job hunt' },
    provider: 'site-a.test',
    covers: ['site-a.test'],
    from: 'signed_in',
    to: 'signed_out',
    reason: 'cookies_absent',
    provider_signed_in: false,
    machine: 'studio-mac',
    at: AT,
    ...patch,
  };
}

function healthPayload(
  t: SigninTransition | undefined,
  site = siteView(),
): DomainEvents['template.health'] {
  const base = TemplateHealthEvent.parse({ type: 'template.health', template_id: TID, site });
  return { ...base, ...(t !== undefined && { transition: t }) };
}

function health(t: SigninTransition | undefined, site = siteView()): ProducedEvent {
  return { name: 'template.health', at: 1, payload: healthPayload(t, site) };
}

function reloginPayload(
  patch: Parameters<typeof reloginView>[0],
): DomainEvents['template.relogin'] {
  return {
    type: 'template.relogin',
    template_id: TID,
    relogin: reloginView({ site_id: 'site-a.test', requested_at: AT, ...patch }),
    names: { name: 'job-hunt', display_name: 'Job hunt' },
    provider: 'site-a.test',
    machine: 'studio-mac',
  };
}

function relogin(patch: Parameters<typeof reloginView>[0]): ProducedEvent {
  return { name: 'template.relogin', at: 1, payload: reloginPayload(patch) };
}

function hostView(patch: Partial<HostView> = {}): HostView {
  return {
    state: 'failed',
    since: AT,
    started_at: null,
    restarts: 5,
    last_error: 'no_display',
    pages: 0,
    parked_pages: 0,
    sandboxed: null,
    profile_secrets: false,
    agents_paused: false,
    ...patch,
  };
}

function hostPayload(
  host: HostView,
  previous: HostView['state'] | undefined,
): DomainEvents['template.host'] {
  const base = TemplateHostEvent.parse({ type: 'template.host', template_id: TID, host });
  return {
    ...base,
    names: { name: 'job-hunt', display_name: 'Job hunt' },
    ...(previous !== undefined && { previous_state: previous }),
  };
}

function hostEvent(host: HostView, previous: HostView['state'] | undefined): ProducedEvent {
  return { name: 'template.host', at: 1, payload: hostPayload(host, previous) };
}

function setup(redactor?: ReturnType<typeof createRedactor>) {
  const clock = new FakeClock();
  const repo = new InMemoryNotificationRepository();
  const service = new NotificationService({
    repo,
    bus: new RecordingEventBus<DomainEvents>(),
    clock,
    ids: new FakeIdGenerator(),
    logger: new CollectingLogger(),
    ...(redactor !== undefined && { redactor }),
  });
  return { clock, repo, service };
}

function messageOf(repo: InMemoryNotificationRepository, id: string | undefined) {
  return NotificationMessage.parse(JSON.parse(repo.rows.get(id ?? '')?.messageJson ?? 'null'));
}

describe('pure rules', () => {
  it('threads are keyed by template and identity provider', () => {
    expect(providerThread(TID, 'site-a.test')).toBe(`template:${TID}:site-a.test`);
    expect(hostThread(TID)).toBe(`template-host:${TID}`);
  });

  it('signinDraft: a sign-out opens the provider thread with the act button', () => {
    const draft = signinDraft(healthPayload(transition()));
    expect(draft).toMatchObject({
      type: 'attention',
      kind: 'template.signed_out',
      state: 'open',
      thread: `template:${TID}:site-a.test`,
      title: 'Job hunt: site-a.test signed out',
      target: `/templates/${TID}?site=site-a.test`,
      once: { kinds: ['template.signed_out', 'template.challenged'] },
    });
    const content = draft?.content(1);
    expect(content?.actions[0]).toMatchObject({
      kind: 'act',
      label: 'Re-login on studio-mac',
      command: { op: 'template.relogin', args: { template_id: TID, site_id: 'site-a.test' } },
    });
    expect(content?.entities).toEqual({
      template_id: TID,
      template_name: 'job-hunt',
      domain: 'site-a.test',
    });
  });

  it('signinDraft: a challenge has no act button; other transitions draft nothing', () => {
    const challenged = signinDraft(healthPayload(transition({ to: 'challenged' })));
    expect(challenged?.kind).toBe('template.challenged');
    expect(challenged?.content(1).actions.map((a) => a.kind)).toEqual(['open']);
    expect(signinDraft(healthPayload(undefined))).toBeNull();
    expect(signinDraft(healthPayload(transition({ to: 'signed_in' })))).toBeNull();
    expect(signinDraft(healthPayload(transition({ to: 'inconclusive' })))).toBeNull();
  });

  it('signinDraft names every site a provider covers', () => {
    const draft = signinDraft(
      healthPayload(
        transition({ provider: 'indeed.com', covers: ['indeed.com', 'glassdoor.com'] }),
      ),
    );
    expect(draft?.body).toContain('indeed.com login (covers indeed.com, glassdoor.com)');
    expect(draft?.thread).toBe(`template:${TID}:indeed.com`);
  });

  it('signinRevision only when the whole provider is signed in again', () => {
    const back = transition({ from: 'signed_out', to: 'signed_in', provider_signed_in: true });
    expect(signinRevision(healthPayload(back))).toMatchObject({
      thread: `template:${TID}:site-a.test`,
      kinds: ['template.signed_out', 'template.challenged'],
      change: { state: 'resolved' },
    });
    expect(signinRevision(healthPayload({ ...back, provider_signed_in: false }))).toBeNull();
    expect(signinRevision(healthPayload(transition()))).toBeNull();
    expect(signinRevision(healthPayload(undefined))).toBeNull();
  });

  it('reloginFailedDraft: failed and timed_out only, final, in the provider thread', () => {
    const timedOut = reloginFailedDraft(reloginPayload({ state: 'timed_out' }));
    expect(timedOut).toMatchObject({
      type: 'error',
      kind: 'template.relogin_failed',
      state: 'final',
      thread: `template:${TID}:site-a.test`,
      title: 'Job hunt: re-login of site-a.test timed out',
      body: 'Nobody signed in within 30 minutes.',
    });
    const vault = reloginFailedDraft(
      reloginPayload({ state: 'failed', method: 'vault', error: 'fill_failed' }),
    );
    expect(vault?.title).toBe('Job hunt: automatic re-login of site-a.test failed');
    expect(vault?.body).toBe('The automatic re-login failed (fill_failed).');
    for (const state of ['open', 'queued', 'signed_in', 'cancelled'] as const) {
      expect(reloginFailedDraft(reloginPayload({ state }))).toBeNull();
    }
  });

  it('hostFailedDraft once on reaching failed; hostRevision when running again', () => {
    expect(hostFailedDraft(hostPayload(hostView(), 'crashed'))).toMatchObject({
      kind: 'template.host_failed',
      state: 'open',
      thread: `template-host:${TID}`,
      title: 'Job hunt: browser failed',
    });
    expect(hostFailedDraft(hostPayload(hostView(), 'failed'))).toBeNull();
    expect(hostFailedDraft(hostPayload(hostView({ state: 'running' }), 'failed'))).toBeNull();
    expect(hostRevision(hostPayload(hostView({ state: 'running' }), 'starting'))).toMatchObject({
      thread: `template-host:${TID}`,
      kinds: ['template.host_failed'],
      change: { state: 'resolved' },
    });
    expect(hostRevision(hostPayload(hostView({ state: 'running' }), 'running'))).toBeNull();
    expect(hostRevision(hostPayload(hostView({ state: 'running' }), undefined))).toBeNull();
    expect(hostRevision(hostPayload(hostView(), 'running'))).toBeNull();
  });
});

describe('through NotificationService', () => {
  it('a sign-out creates exactly one contract-valid template.signed_out per provider', async () => {
    const { clock, repo, service } = setup();
    const [created] = await service.produce(health(transition()));
    expect(created).toMatchObject({
      kind: 'template.signed_out',
      category: 'needs-you',
      severity: 'warn',
      state: 'open',
      thread: `template:${TID}:site-a.test`,
    });
    const message = messageOf(repo, created?.notification_id);
    expect(message.actions).toContainEqual(
      expect.objectContaining({
        kind: 'act',
        label: 'Re-login on studio-mac',
        command: { op: 'template.relogin', args: { template_id: TID, site_id: 'site-a.test' } },
      }),
    );
    // A second sign-out of the same provider while it is open creates nothing.
    await clock.advance(60_000);
    expect(await service.produce(health(transition({ at: AT + 60_000 })))).toEqual([]);
    expect(
      await service.produce(health(transition({ to: 'challenged', at: AT + 61_000 }))),
    ).toEqual([]);
    expect(repo.rows.size).toBe(1);
    // Another provider of the template gets its own thread.
    const other = transition({ provider: 'site-b.test', covers: ['site-b.test'] });
    expect(await service.produce(health(other, siteView('site-b.test')))).toHaveLength(1);
  });

  it('signed in again resolves it, even after a later relogin_failed in the thread', async () => {
    const { clock, repo, service } = setup();
    const [created] = await service.produce(health(transition()));
    await clock.advance(1_000);
    const [failed] = await service.produce(relogin({ state: 'timed_out' }));
    expect(failed).toMatchObject({
      kind: 'template.relogin_failed',
      state: 'final',
      thread: created?.thread,
    });
    messageOf(repo, failed?.notification_id);
    await clock.advance(1_000);
    const back = transition({
      from: 'signed_out',
      to: 'signed_in',
      provider_signed_in: true,
      at: AT + 2_000,
    });
    const [resolved] = await service.produce(health(back));
    expect(resolved).toMatchObject({
      notification_id: created?.notification_id,
      kind: 'template.signed_out',
      state: 'resolved',
      revision: 2,
    });
    expect(messageOf(repo, created?.notification_id).state).toBe('resolved');
    expect(repo.rows.get(failed?.notification_id ?? '')?.state).toBe('final');
  });

  it('a site signed in while its provider is still out resolves nothing', async () => {
    const { service } = setup();
    await service.produce(health(transition()));
    const partial = transition({ from: 'signed_out', to: 'signed_in', provider_signed_in: false });
    expect(await service.produce(health(partial))).toEqual([]);
  });

  it('a failed or timed-out re-login creates one template.relogin_failed', async () => {
    const { repo, service } = setup();
    const event = relogin({ state: 'failed', method: 'vault', error: 'not_authorized' });
    const [failed] = await service.produce(event);
    expect(failed).toMatchObject({
      kind: 'template.relogin_failed',
      category: 'problems',
      state: 'final',
    });
    expect(messageOf(repo, failed?.notification_id).summary).toBe(
      'The vault binding does not allow this template.',
    );
    // A replay of the same re-login creates nothing.
    expect(await service.produce(event)).toEqual([]);
    expect(await service.produce(relogin({ state: 'signed_in' }))).toEqual([]);
    expect(repo.rows.size).toBe(1);
  });

  it('a failed browser opens template.host_failed; running again resolves it', async () => {
    const { repo, service } = setup();
    const [failed] = await service.produce(hostEvent(hostView(), 'crashed'));
    expect(failed).toMatchObject({
      kind: 'template.host_failed',
      severity: 'error',
      state: 'open',
      thread: `template-host:${TID}`,
    });
    messageOf(repo, failed?.notification_id);
    const running = hostView({ state: 'running', since: AT + 5_000 });
    const [resolved] = await service.produce(hostEvent(running, 'starting'));
    expect(resolved).toMatchObject({
      notification_id: failed?.notification_id,
      state: 'resolved',
      revision: 2,
    });
  });

  it('a registered sentinel in a display name or reason never reaches the notification', async () => {
    const secret = ['sentinel', 'value', 'for', 'tests'].join('-');
    const clock = new FakeClock();
    const registry = new SecretRegistry({ now: () => clock.now() });
    registry.add(secret);
    const { repo, service } = setup(createRedactor(registry));
    await service.produce(
      health(
        transition({
          template: { name: 'job-hunt', display_name: `Jobs ${secret}` },
          reason: `bad ${secret}`,
        }),
      ),
    );
    await service.produce(relogin({ state: 'failed', error: `err_${secret}` }));
    await service.produce(
      hostEvent(hostView({ last_error: `launch failed near ${secret}` }), 'crashed'),
    );
    expect(repo.rows.size).toBe(3);
    const stored = JSON.stringify([...repo.rows.values()]);
    expect(stored).not.toContain(secret);
    for (const row of repo.rows.values()) messageOf(repo, row.notificationId);
  });
});
