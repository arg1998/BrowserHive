/** @module app/templates/host-supervisor.test — the host supervisor over a fake launcher and fake clock: lazy start and join, admission codes, browser slots, page caps, crash fan-out and backoff, `failed`, operator stop, idle stop, recycle, maintenance sessions and `server_status`. */

import { describe, expect, it } from 'bun:test';
import { CollectingLogger } from '../../../test/helpers/collecting-logger.ts';
import { FakeBrowserDriver } from '../../../test/helpers/fake-browser-driver.ts';
import { FakeClock } from '../../../test/helpers/fake-clock.ts';
import { FakeIdGenerator } from '../../../test/helpers/fake-id-generator.ts';
import { FakeTemplateLauncher } from '../../../test/helpers/fake-template-host.ts';
import { RecordingDegradations } from '../../../test/helpers/template-kit.ts';
import { templateRecord, templateSiteRecord } from '../../../test/persistence/helpers.ts';
import type { SessionPrincipal } from '../../domain/session/principal.ts';
import { AppError, isAppError } from '../../kernel/errors/app-error.ts';
import type { TemplateRecord } from '../../ports/persistence/index.ts';
import type { TemplateLaunchRequest } from '../../ports/template-runtime.ts';
import { InProcessEventBus } from '../events/bus.ts';
import type { DomainEvents } from '../events/catalog.ts';
import { SessionService } from '../sessions/session-service.ts';
import { FakeSessionDirFs, testConfig } from '../sessions/test-support.ts';
import { RESTART_BACKOFF_MS } from './host-state.ts';
import { TemplateHostSupervisor } from './host-supervisor.ts';

const AGENT: SessionPrincipal = { subject: 'agent' };

/** Lets pending promise chains settle (the fake clock only drives `sleep`). */
async function flush(): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise<void>((resolve) => setImmediate(resolve));
}

function setup(options: { maxSessions?: number; maxPagesPerHost?: number } = {}) {
  const clock = new FakeClock(1_700_000_000_000);
  const logger = new CollectingLogger();
  const bus = new InProcessEventBus<DomainEvents>({ clock, logger });
  const driver = new FakeBrowserDriver();
  const sessions = new SessionService({
    clock,
    ids: new FakeIdGenerator(),
    logger,
    bus,
    driver,
    proxyResolver: { resolve: async (r) => r.requested },
    config: testConfig({ maxSessions: options.maxSessions ?? 3 }),
    fs: new FakeSessionDirFs(),
  });
  const launcher = new FakeTemplateLauncher();
  const degradations = new RecordingDegradations();
  const updates: string[] = [];
  const supervisor = new TemplateHostSupervisor({
    launcher,
    sessions,
    templates: {
      update: async (id, patch) => {
        updates.push(Object.keys(patch).join(','));
        return templateRecord({ templateId: id, ...patch });
      },
      touchLastUsed: async () => undefined,
    },
    clock,
    logger,
    degradations,
    spec: {
      dataDir: '/data',
      stealthDriver: 'auto',
      proxyResolver: { resolve: async (r) => r.requested },
      env: {},
      selfOrigins: () => ['http://127.0.0.1:9876'],
      testingArgs: [],
    },
    config: {
      idleTimeoutMs: 3_600_000,
      recycleAfterMs: 86_400_000,
      drainTimeoutMs: 60_000,
      maxPagesPerHost: options.maxPagesPerHost ?? 40,
      closeTimeoutMs: 1_000,
    },
  });
  return { clock, sessions, driver, launcher, degradations, supervisor, updates };
}

function request(template: TemplateRecord, slug = 'jobs'): TemplateLaunchRequest {
  return {
    template,
    sites: [templateSiteRecord()],
    slug,
    connectionId: null,
    client: null,
    principal: AGENT,
    sealing: {
      hideCookieValues: true,
      forceDisableEvaluate: true,
      refuseCookieWrites: true,
      refuseStateExport: true,
    },
    sealed: true,
    settings: {
      channel: template.channel,
      headless: template.headless,
      stealth: false,
      fingerprint: false,
      humanize: false,
      disableEvaluate: true,
      incognito: false,
      persistenceMode: 'memory',
      vaultEnabled: false,
      contextOptions: {},
    },
  };
}

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
    return 'ok';
  } catch (err) {
    return isAppError(err)
      ? `${err.code}${'limit_kind' in (err.details as object) ? `:${(err.details as { limit_kind: string }).limit_kind}` : ''}`
      : String(err);
  }
}

describe('TemplateHostSupervisor launches', () => {
  it('starts the host lazily, records the template columns, and joins one host for every session', async () => {
    const { supervisor, launcher } = setup();
    const template = templateRecord({ headless: true });
    expect(supervisor.host(template.templateId).state).toBe('stopped');
    const a = await supervisor.launch(request(template, 'one'));
    const b = await supervisor.launch(request(template, 'two'));
    expect(launcher.specs).toHaveLength(1);
    expect(launcher.specs[0]?.userDataDir).toMatch(/templates[\\/]tp-fixture001[\\/]userdata$/);
    expect(launcher.specs[0]?.selfOrigins).toEqual(['http://127.0.0.1:9876']);
    expect(a.template).toMatchObject({
      templateId: template.templateId,
      mode: 'live',
      sealed: true,
    });
    expect(a.template?.sites).toEqual([{ site: 'site-a.test', status: 'unknown' }]);
    expect(a.request.persistenceMode).toBe('memory');
    expect(a.request.disableEvaluate).toBe(true);
    expect(supervisor.host(template.templateId)).toMatchObject({
      state: 'running',
      liveAgentSessions: 2,
      pages: 2,
    });
    expect(supervisor.liveSessions(template.templateId)).toEqual([a.id, b.id]);
  });

  it('two concurrent first launches start one host', async () => {
    const { supervisor, launcher } = setup();
    launcher.hold = true;
    const template = templateRecord();
    const first = supervisor.launch(request(template, 'one'));
    const second = supervisor.launch(request(template, 'two'));
    await flush();
    expect(supervisor.host(template.templateId).state).toBe('starting');
    launcher.release();
    await Promise.all([first, second]);
    expect(launcher.specs).toHaveLength(1);
  });

  it('a host start counts one browser slot; virtual sessions none; server_status counts browsers', async () => {
    const { supervisor, sessions } = setup({ maxSessions: 2 });
    const template = templateRecord({ maxConcurrent: 5 });
    await supervisor.launch(request(template, 'one'));
    await supervisor.launch(request(template, 'two'));
    await supervisor.launch(request(template, 'three'));
    expect(sessions.occupiedSlots()).toBe(1);
    expect(sessions.serverStatus().count).toBe(1);
    await sessions.create({ slug: 'plain' }, AGENT);
    expect(sessions.serverStatus().count).toBe(2);
    // A second template's host needs a slot and none is free.
    const other = templateRecord({ templateId: 'tp-other00001', name: 'other' });
    expect(await codeOf(supervisor.launch(request(other)))).toBe('SESSION_LIMIT_REACHED');
    expect(supervisor.host(other.templateId).state).toBe('stopped');
  });

  it('refuses at the template cap and at the host page cap with TEMPLATE_BUSY capacity', async () => {
    const { supervisor } = setup({ maxPagesPerHost: 2 });
    const template = templateRecord({ maxConcurrent: 2 });
    await supervisor.launch(request(template, 'one'));
    await supervisor.launch(request(template, 'two'));
    expect(await codeOf(supervisor.launch(request(template, 'three')))).toBe(
      'TEMPLATE_BUSY:capacity',
    );
    const wide = templateRecord({ templateId: 'tp-wide000001', name: 'wide', maxConcurrent: 5 });
    const pages = setup({ maxPagesPerHost: 2 });
    await pages.supervisor.launch(request(wide, 'one'));
    await pages.supervisor.launch(request(wide, 'two'));
    expect(await codeOf(pages.supervisor.launch(request(wide, 'three')))).toBe(
      'TEMPLATE_BUSY:capacity',
    );
  });

  it('new_tab answers TEMPLATE_BUSY tabs at the per-session cap and capacity at the host cap', async () => {
    const { supervisor, launcher } = setup({ maxPagesPerHost: 6 });
    const template = templateRecord({ maxConcurrent: 3 });
    const a = await supervisor.launch(request(template, 'one'));
    const b = await supervisor.launch(request(template, 'two'));
    const host = launcher.last;
    host.newPage(a.id); // a: 2 pages = max(2, floor(6 / 3))
    expect(await codeOf(Promise.resolve().then(() => host.newPage(a.id)))).toBe(
      'TEMPLATE_BUSY:tabs',
    );
    host.newPage(b.id);
    await supervisor.launch(request(template, 'three'));
    host.newPage(supervisor.liveSessions(template.templateId)[2] ?? '');
    expect(await codeOf(Promise.resolve().then(() => host.newPage(b.id)))).toBe(
      'TEMPLATE_BUSY:capacity',
    );
  });

  it('a window that cannot be opened answers TEMPLATE_UNAVAILABLE and frees the session', async () => {
    const { supervisor, launcher, sessions } = setup();
    const template = templateRecord();
    await supervisor.launch(request(template, 'one'));
    launcher.last.failOpen = new Error('window not adopted in time');
    expect(await codeOf(supervisor.launch(request(template, 'two')))).toBe('TEMPLATE_UNAVAILABLE');
    expect(sessions.listAll()).toHaveLength(1);
  });
});

describe('TemplateHostSupervisor host lifecycle', () => {
  it('a crash fails every session, answers recovering, and restarts after the backoff', async () => {
    const { supervisor, launcher, sessions, clock } = setup();
    const template = templateRecord();
    const a = await supervisor.launch(request(template, 'one'));
    const b = await supervisor.launch(request(template, 'two'));
    launcher.last.exit();
    expect(a.dead && b.dead).toBe(true);
    expect(supervisor.host(template.templateId).state).toBe('crashed');
    expect(await codeOf(supervisor.launch(request(template, 'three')))).toBe(
      'TEMPLATE_UNAVAILABLE',
    );
    await clock.advance(RESTART_BACKOFF_MS[0] ?? 0);
    await flush();
    expect(launcher.hosts).toHaveLength(2);
    expect(supervisor.host(template.templateId)).toMatchObject({ state: 'running', restarts: 1 });
    await Promise.resolve();
    expect(sessions.listAll().filter((s) => !s.dead)).toHaveLength(0);
  });

  it('five failures within 30 minutes set failed, report TEMPLATE_HOST_FAILED, and answer TEMPLATE_DISABLED', async () => {
    const { supervisor, launcher, clock, degradations } = setup();
    const template = templateRecord();
    for (let i = 0; i < 5; i++) launcher.failures.push(new Error(`start ${i}`));
    expect(await codeOf(supervisor.launch(request(template)))).toBe('TEMPLATE_UNAVAILABLE');
    for (const delay of RESTART_BACKOFF_MS.slice(0, 4)) {
      await flush();
      await clock.advance(delay);
      await flush();
    }
    expect(supervisor.host(template.templateId).state).toBe('failed');
    expect(degradations.reports.map((r) => r.code)).toEqual(['TEMPLATE_HOST_FAILED']);
    expect(degradations.reports[0]?.details).toMatchObject({ reason: 'host_failed', attempts: 5 });
    expect(await codeOf(supervisor.launch(request(template)))).toBe('TEMPLATE_DISABLED');
  });

  it('a display failure sets failed at once with reason no_display', async () => {
    const { supervisor, launcher } = setup();
    launcher.failures.push(new AppError('INTERNAL_ERROR', { ref: 'no_display' }));
    const template = templateRecord();
    expect(await codeOf(supervisor.launch(request(template)))).toBe('TEMPLATE_DISABLED');
    expect(supervisor.host(template.templateId)).toMatchObject({
      state: 'failed',
      lastError: 'no_display',
    });
  });

  it('an operator stop closes the sessions with reason operator and restarts nothing', async () => {
    const { supervisor, launcher, sessions, clock } = setup();
    const template = templateRecord();
    const a = await supervisor.launch(request(template, 'one'));
    launcher.last.exit({ reason: 'browser disconnected', operatorStop: true });
    await clock.advance(1);
    expect(a.closedReason).toBe('operator');
    expect(supervisor.host(template.templateId).state).toBe('stopped');
    await clock.advance(10 * 60_000);
    expect(launcher.hosts).toHaveLength(1);
    expect(sessions.listAll()).toHaveLength(0);
    await supervisor.launch(request(template, 'two'));
    expect(launcher.hosts).toHaveLength(2);
  });

  it('an idle host stops after templateHostIdleTimeout; a parked page keeps it', async () => {
    const { supervisor, launcher, sessions, clock } = setup();
    const template = templateRecord();
    const a = await supervisor.launch(request(template, 'one'));
    await sessions.close(a.id);
    launcher.last.parked = [{ targetId: 'T', url: 'https://site-a.test/', openedAt: 0 }];
    await supervisor.tick();
    await clock.advance(3_600_000);
    await supervisor.tick();
    expect(supervisor.host(template.templateId).state).toBe('running');
    launcher.last.parked = [];
    await supervisor.tick();
    await clock.advance(3_600_000);
    await supervisor.tick();
    expect(supervisor.host(template.templateId).state).toBe('stopped');
    expect(launcher.last.closed).toBe(1);
  });

  it('recycles an old host: draining refuses launches, then force-closes after the drain timeout', async () => {
    const { supervisor, launcher, clock } = setup();
    const template = templateRecord();
    const a = await supervisor.launch(request(template, 'one'));
    await clock.advance(86_400_000);
    await supervisor.tick();
    expect(supervisor.host(template.templateId).state).toBe('draining');
    expect(await codeOf(supervisor.launch(request(template, 'two')))).toBe('TEMPLATE_UNAVAILABLE');
    for (let i = 0; i < 61; i++) {
      await clock.advance(1_000);
      await flush();
    }
    expect(a.closedReason).toBe('shutdown');
    expect(supervisor.host(template.templateId).state).toBe('stopped');
    expect(launcher.last.closed).toBe(1);
  });

  it('records the observed identity at the first start only', async () => {
    const { supervisor, launcher, updates } = setup();
    launcher.identity = {
      userAgent: 'Mozilla/5.0 Chrome/140.0.0.0',
      brands: [{ brand: 'Chromium', version: '140' }],
      platform: 'Linux',
      deviceMemory: 8,
      chromeMajor: '140',
      geo: null,
      display: null,
    };
    await supervisor.launch(request(templateRecord(), 'one'));
    await Promise.resolve();
    expect(updates).toEqual(['identityObserved']);
  });

  it('shutdown closes every session of the template and stops the host', async () => {
    const { supervisor, launcher, sessions } = setup();
    const template = templateRecord();
    const a = await supervisor.launch(request(template, 'one'));
    expect(await supervisor.shutdown(template.templateId)).toEqual([a.id]);
    expect(sessions.listAll()).toHaveLength(0);
    expect(launcher.last.closed).toBe(1);
    expect(supervisor.slots()).toBe(0);
  });
});

describe('maintenance sessions', () => {
  it('are never listed, never counted, have no cap, and keep no lease', async () => {
    const { supervisor, sessions, clock } = setup();
    const template = templateRecord({ maxConcurrent: 1 });
    const own = await supervisor.launchMaintenance({
      template,
      sites: [],
      slug: 'maintenance',
      principal: { subject: 'browserhive' },
    });
    expect(own.template?.mode).toBe('maintenance');
    expect(sessions.list({ subject: 'browserhive' })).toEqual([]);
    expect(supervisor.liveSessions(template.templateId)).toEqual([]);
    // The cap counts agent sessions only.
    await supervisor.launch(request(template, 'one'));
    expect(supervisor.host(template.templateId).pages).toBe(1);
    await clock.advance(10 * 3_600_000);
    expect(own.isLeaseExpired(clock.now())).toBe(true);
    expect(sessions.peek(own.id)).toBe(own);
  });
});

describe('review fixes (PR #76)', () => {
  it('F3: an operator stop through the real view semantics closes sessions with reason operator', async () => {
    const { supervisor, launcher, clock } = setup();
    const a = await supervisor.launch(request(templateRecord(), 'one'));
    launcher.last.exit({ reason: 'browser disconnected', operatorStop: true });
    await clock.advance(1);
    await flush();
    expect(a.dead).toBe(false);
    expect(a.closedReason).toBe('operator');
  });

  it('F4: a launch during an idle stop is refused typed and nothing stays live on the closed host', async () => {
    const { supervisor, launcher, sessions, clock } = setup();
    const template = templateRecord();
    await supervisor.launchMaintenance({
      template,
      sites: [],
      slug: 'maintenance',
      principal: { subject: 'browserhive' },
    });
    const host = launcher.last;
    const [maintenance] = [...host.views.values()];
    if (maintenance === undefined) throw new Error('no maintenance view');
    const close = maintenance.close.bind(maintenance);
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    maintenance.close = async (deadline, signal) => {
      await gate;
      return close(deadline, signal);
    };
    await supervisor.tick();
    await clock.advance(3_600_000);
    const ticking = supervisor.tick();
    await flush();
    expect(supervisor.host(template.templateId).state).toBe('draining');
    expect(await codeOf(supervisor.launch(request(template, 'late')))).toBe('TEMPLATE_UNAVAILABLE');
    release();
    await ticking;
    await flush();
    expect(supervisor.host(template.templateId).state).toBe('stopped');
    expect(host.closed).toBe(1);
    expect(sessions.listAll().filter((s) => !s.dead && s.state.kind === 'live')).toEqual([]);
    // The next launch starts a fresh host.
    await supervisor.launch(request(template, 'next'));
    expect(launcher.hosts).toHaveLength(2);
  });

  it('F7: closed virtual sessions leave no exit listener on a long-lived host', async () => {
    const { supervisor, launcher, sessions } = setup();
    const template = templateRecord();
    await supervisor.launch(request(template, 'first'));
    const host = launcher.last;
    const baseline = host.exits.size;
    for (let i = 0; i < 20; i++) {
      const s = await supervisor.launch(request(template, `cycle${i}`));
      await sessions.close(s.id);
    }
    expect(host.exits.size).toBe(baseline);
  });

  it('M23: a launch admitted but not yet reserved counts toward the template cap', async () => {
    const { supervisor } = setup();
    const template = templateRecord({ maxConcurrent: 1 });
    // Both are admitted in the same turn, before the first reaches the registry.
    const first = supervisor.launch(request(template, 'one'));
    const second = codeOf(supervisor.launch(request(template, 'two')));
    expect(await second).toBe('TEMPLATE_BUSY:capacity');
    await first;
  });
});

describe('T1b: holds, checkpoints and memory (spec 13 §3.2, §3.9, §3.12)', () => {
  it('a held template refuses agent launches and foreign maintenance launches until released', async () => {
    const { supervisor } = setup();
    const template = templateRecord({ headless: true });
    const hold = supervisor.holds.hold(template.templateId);
    expect(hold).not.toBeNull();
    if (hold === null) throw new Error('no hold');
    expect(supervisor.holds.hold(template.templateId)).toBeNull();
    expect(await codeOf(supervisor.launch(request(template)))).toBe('TEMPLATE_UNAVAILABLE');
    const maintenance = {
      template,
      sites: [],
      slug: 'maintenance',
      principal: { subject: 'browserhive' },
    };
    expect(await codeOf(supervisor.launchMaintenance(maintenance))).toBe('TEMPLATE_UNAVAILABLE');
    expect(
      await codeOf(supervisor.launchMaintenance({ ...maintenance, holdToken: hold.token })),
    ).toBe('ok');
    hold.release();
    expect(await codeOf(supervisor.launch(request(template)))).toBe('ok');
  });

  it('a deleted template never starts a browser again (review #79 H-1)', async () => {
    const { supervisor, launcher } = setup();
    const template = templateRecord({ headless: true });
    await supervisor.launch(request(template));
    await supervisor.shutdown(template.templateId);
    const started = launcher.specs.length;
    const maintenance = {
      template,
      sites: [],
      slug: 'maintenance',
      principal: { subject: 'browserhive' },
    };
    expect(await codeOf(supervisor.launchMaintenance(maintenance))).toBe('TEMPLATE_NOT_FOUND');
    expect(await codeOf(supervisor.launch(request(template, 'again')))).toBe('TEMPLATE_NOT_FOUND');
    expect(launcher.specs.length).toBe(started);
  });

  it('a clean stop checkpoints before the browser closes; a delete does not', async () => {
    const { supervisor, launcher } = setup();
    const calls: string[] = [];
    supervisor.attachCheckpoints({
      checkpoint: async (id) => {
        calls.push(`checkpoint:${id}:closed=${launcher.hosts[0]?.closed ?? -1}`);
      },
      checkpointIfDue: async (id) => void calls.push(`due:${id}`),
    });
    const template = templateRecord({ headless: true });
    await supervisor.launch(request(template));
    await supervisor.tick();
    expect(calls).toEqual([`due:${template.templateId}`]);
    await supervisor.stopHost(template.templateId, 'operator');
    expect(calls.at(-1)).toBe(`checkpoint:${template.templateId}:closed=0`);
    await supervisor.launch(request(template, 'again'));
    const before = calls.length;
    await supervisor.shutdown(template.templateId);
    expect(calls.length).toBe(before);
  });

  it('a host above templateRecycleRss warns its largest session first, then drains', async () => {
    const { clock, sessions, launcher, degradations } = setup();
    const supervisor = new TemplateHostSupervisor({
      launcher,
      sessions: new SessionService({
        clock,
        ids: new FakeIdGenerator(),
        logger: new CollectingLogger(),
        bus: new InProcessEventBus<DomainEvents>({ clock, logger: new CollectingLogger() }),
        driver: new FakeBrowserDriver(),
        proxyResolver: { resolve: async (r) => r.requested },
        config: testConfig({ maxSessions: 3 }),
        fs: new FakeSessionDirFs(),
      }),
      templates: {
        update: async (id, patch) => templateRecord({ templateId: id, ...patch }),
        touchLastUsed: async () => undefined,
      },
      clock,
      logger: new CollectingLogger(),
      degradations,
      spec: {
        dataDir: '/data',
        stealthDriver: 'auto',
        proxyResolver: { resolve: async (r) => r.requested },
        env: {},
        selfOrigins: () => [],
        testingArgs: [],
      },
      config: {
        idleTimeoutMs: 0,
        recycleAfterMs: 0,
        drainTimeoutMs: 60_000,
        maxPagesPerHost: 40,
        closeTimeoutMs: 1_000,
        recycleRssBytes: 1_000,
      },
      rssOf: async () => 5_000,
    });
    void sessions;
    const template = templateRecord({ headless: true });
    const a = await supervisor.launch(request(template, 'alpha'));
    const host = launcher.hosts.at(-1);
    if (host === undefined) throw new Error('no host');
    host.heaps = [{ sessionId: a.id, targetId: 'A1', jsHeapTotalBytes: 900 }];
    await supervisor.tick();
    expect(host.closedPages).toEqual([{ targetId: 'A1', scope: 'session' }]);
    expect(a.warnings.map((w) => w.code)).toEqual(['SESSION_RESOURCE_LIMIT']);
    expect(supervisor.host(template.templateId).state).toBe('running');
    await clock.advance(6 * 60_000);
    await supervisor.tick();
    expect(supervisor.host(template.templateId).state).toBe('draining');
  });
});
