/** @module app/templates/host-supervisor-strategies.test — the admission strategies inside a virtual-session launch over a fake launcher and fake clock (spec 13 §3.7, §6.3, §9.6): a `launch-spacing` wait counts toward the cap and ends with a launch, a refusal starts no browser, the pack concurrency cap lowers the template and page caps, `active-hours` refuses before the host starts, and a supervisor without packs applies none. */

import { describe, expect, it } from 'bun:test';
import type { SitePackV1 } from '@browserhive/contracts/site-packs';
import { CollectingLogger } from '../../../test/helpers/collecting-logger.ts';
import { FakeBrowserDriver } from '../../../test/helpers/fake-browser-driver.ts';
import { FakeClock } from '../../../test/helpers/fake-clock.ts';
import { FakeIdGenerator } from '../../../test/helpers/fake-id-generator.ts';
import { FakeTemplateLauncher } from '../../../test/helpers/fake-template-host.ts';
import { PacksLookup, strategyPack } from '../../../test/helpers/packs-lookup.ts';
import { RecordingDegradations } from '../../../test/helpers/template-kit.ts';
import { templateRecord, templateSiteRecord } from '../../../test/persistence/helpers.ts';
import { isAppError } from '../../kernel/errors/app-error.ts';
import type { TemplateRecord } from '../../ports/persistence/index.ts';
import type { TemplateLaunchRequest } from '../../ports/template-runtime.ts';
import { InProcessEventBus } from '../events/bus.ts';
import type { DomainEvents } from '../events/catalog.ts';
import { SessionService } from '../sessions/session-service.ts';
import { FakeSessionDirFs, testConfig } from '../sessions/test-support.ts';
import { TemplateHostSupervisor } from './host-supervisor.ts';

/** Tuesday 17 Nov 2026 17:00 UTC: 12:00 in Toronto (the fixture template's zone). */
const NOON_TORONTO = Date.UTC(2026, 10, 17, 17);

async function flush(): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise<void>((resolve) => setImmediate(resolve));
}

function setup(packs: readonly SitePackV1[] | null, maxPagesPerHost = 40) {
  const clock = new FakeClock(NOON_TORONTO);
  const logger = new CollectingLogger();
  const bus = new InProcessEventBus<DomainEvents>({ clock, logger });
  const sessions = new SessionService({
    clock,
    ids: new FakeIdGenerator(),
    logger,
    bus,
    driver: new FakeBrowserDriver(),
    proxyResolver: { resolve: async (r) => r.requested },
    config: testConfig({ maxSessions: 3 }),
    fs: new FakeSessionDirFs(),
  });
  const launcher = new FakeTemplateLauncher();
  const lookup = packs === null ? null : new PacksLookup(packs);
  const supervisor = new TemplateHostSupervisor({
    launcher,
    sessions,
    templates: {
      update: async (id, patch) => templateRecord({ templateId: id, ...patch }),
      touchLastUsed: async () => undefined,
    },
    clock,
    logger,
    degradations: new RecordingDegradations(),
    spec: {
      dataDir: '/data',
      proxyResolver: { resolve: async (r) => r.requested },
      env: {},
      selfOrigins: () => [],
      testingArgs: [],
    },
    config: {
      idleTimeoutMs: 3_600_000,
      recycleAfterMs: 86_400_000,
      drainTimeoutMs: 60_000,
      maxPagesPerHost,
      closeTimeoutMs: 1_000,
    },
    ...(lookup !== null && { sitePacks: () => lookup }),
    random: () => 0,
  });
  return { clock, launcher, supervisor };
}

function request(template: TemplateRecord, slug: string): TemplateLaunchRequest {
  const sealing = {
    hideCookieValues: true,
    forceDisableEvaluate: true,
    refuseCookieWrites: true,
    refuseStateExport: true,
  };
  return {
    template,
    sites: [templateSiteRecord()],
    slug,
    connectionId: null,
    client: null,
    principal: { subject: 'agent' },
    sealing,
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

async function outcome(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
    return 'ok';
  } catch (err) {
    if (!isAppError(err)) return String(err);
    const d = err.details as { limit_kind?: string; retry_after_ms?: number };
    return `${err.code}:${d.limit_kind ?? ''}:${d.retry_after_ms ?? ''}`;
  }
}

const spacing = (gap: number) =>
  strategyPack('site-a.test', {
    strategies: [{ id: 'launch-spacing', params: { min_gap_s: gap, jitter_pct: 0 } }],
  });

describe('launch-spacing in a launch', () => {
  it('the second launch waits its turn (counted toward the cap), then launches', async () => {
    const { supervisor, clock } = setup([spacing(10)]);
    const template = templateRecord({ maxConcurrent: 2 });
    await supervisor.launch(request(template, 'one'));
    let second = 'pending';
    const waiting = supervisor.launch(request(template, 'two')).then(
      () => {
        second = 'ok';
      },
      (err: unknown) => {
        second = String(err);
      },
    );
    await flush();
    expect(second).toBe('pending');
    expect(clock.pendingSleeps).toBeGreaterThan(0);
    // The waiting launch holds a place: a third is over the cap of 2.
    expect(await outcome(supervisor.launch(request(template, 'three')))).toBe(
      'TEMPLATE_BUSY:capacity:5000',
    );
    await clock.advance(10_000);
    await waiting;
    expect(second).toBe('ok');
    expect(supervisor.liveSessions(template.templateId)).toHaveLength(2);
  });

  it('a turn beyond 20 s is refused with the time to it, before any browser starts', async () => {
    const { supervisor, launcher } = setup([spacing(30)]);
    const template = templateRecord({ maxConcurrent: 5, status: 'ready' });
    await supervisor.launch(request(template, 'one'));
    expect(await outcome(supervisor.launch(request(template, 'two')))).toBe(
      'TEMPLATE_BUSY:capacity:30000',
    );
    expect(launcher.specs).toHaveLength(1);
    expect(supervisor.liveSessions(template.templateId)).toHaveLength(1);
  });
});

describe('caps and hours from the packs', () => {
  it('the pack concurrency cap lowers the template cap and the page caps follow it', async () => {
    const pack = strategyPack('site-a.test', {
      concurrency: { max_sessions: 1, source: { url: 'https://a.test/', kind: 'observed' } },
    });
    const { supervisor, launcher } = setup([pack], 6);
    const template = templateRecord({ maxConcurrent: 3 });
    expect(supervisor.cap(template, [templateSiteRecord()])).toBe(1);
    const a = await supervisor.launch(request(template, 'one'));
    expect(await outcome(supervisor.launch(request(template, 'two')))).toBe(
      'TEMPLATE_BUSY:capacity:5000',
    );
    // max(2, floor(6 / 1)) = 6 pages per session instead of floor(6 / 3) = 2.
    const host = launcher.last;
    host.newPage(a.id);
    host.newPage(a.id);
    expect(host.sessionPageCount(a.id)).toBe(3);
  });

  it('ramp-up lowers the cap of a young template', async () => {
    const pack = strategyPack('site-a.test', {
      strategies: [{ id: 'ramp-up', params: { days: 10, start_fraction: 0.3 } }],
    });
    const { supervisor } = setup([pack]);
    const young = templateRecord({ maxConcurrent: 5, createdAt: NOON_TORONTO });
    expect(supervisor.cap(young, [templateSiteRecord()])).toBe(2);
    await supervisor.launch(request(young, 'one'));
    await supervisor.launch(request(young, 'two'));
    expect(await outcome(supervisor.launch(request(young, 'three')))).toBe(
      'TEMPLATE_BUSY:capacity:5000',
    );
    // A disabled site's pack does not count.
    expect(supervisor.cap(young, [templateSiteRecord({ enabled: false })])).toBe(5);
  });

  it('active-hours refuses outside the window before the host starts', async () => {
    const pack = strategyPack('site-a.test', {
      strategies: [{ id: 'active-hours', params: { start_hour: 14, end_hour: 18 } }],
    });
    const { supervisor, launcher } = setup([pack]);
    expect(await outcome(supervisor.launch(request(templateRecord(), 'one')))).toBe(
      'TEMPLATE_BUSY:capacity:7200000',
    );
    expect(launcher.specs).toHaveLength(0);
  });

  it('a supervisor without packs (sitePacks=false) applies none of them', async () => {
    const { supervisor } = setup(null);
    const template = templateRecord({ maxConcurrent: 3, createdAt: NOON_TORONTO });
    expect(supervisor.cap(template, [templateSiteRecord()])).toBe(3);
    await supervisor.launch(request(template, 'one'));
    await supervisor.launch(request(template, 'two'));
    expect(supervisor.liveSessions(template.templateId)).toHaveLength(2);
  });
});
