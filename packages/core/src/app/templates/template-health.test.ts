/** @module app/templates/template-health.test — probing a template's sites over a fake host jar (spec 13 §8.1–§8.3): probe rows, health updates, the `template.probe` and `template.health` events with their sign-in transition, the signed-out hook, start modes, per-template serialization and `record()`. */

import { beforeEach, describe, expect, it } from 'bun:test';
import { CollectingLogger } from '../../../test/helpers/collecting-logger.ts';
import { FakeClock } from '../../../test/helpers/fake-clock.ts';
import { deferred, FakeProbeHosts, until } from '../../../test/helpers/fake-probe-hosts.ts';
import { FakeTemplateHost, fakeCookie } from '../../../test/helpers/fake-template-host.ts';
import { InMemoryRepositories } from '../../../test/helpers/in-memory-repos.ts';
import { RecordingEventBus } from '../../../test/helpers/recording-event-bus.ts';
import { templateRecord, templateSiteRecord } from '../../../test/persistence/helpers.ts';
import type { ProbeVerdict } from '../../domain/templates/probe.ts';
import { isAppError } from '../../kernel/errors/app-error.ts';
import type { TemplateRecord, TemplateSiteRecord } from '../../ports/persistence/index.ts';
import type { DomainEvents } from '../events/catalog.ts';
import { GENERIC_PROBER, type ProberSelector, type SiteProber } from './site-prober.ts';
import { TemplateHealthService } from './template-health.ts';

const ID = templateRecord().templateId;

let clock: FakeClock;
let repos: InMemoryRepositories;
let hosts: FakeProbeHosts;
let host: FakeTemplateHost;
let bus: RecordingEventBus<DomainEvents>;
let logger: CollectingLogger;
let changed: string[];
let signedOut: { template: TemplateRecord; site: TemplateSiteRecord }[];
let prober: SiteProber;

function service(): TemplateHealthService {
  const probers: ProberSelector = () => prober;
  const health = new TemplateHealthService({
    repos,
    hosts,
    clock,
    logger,
    bus,
    changed: (id) => changed.push(id),
    machine: 'studio-mac',
    probers,
  });
  health.attach({ signedOut: (template, site) => signedOut.push({ template, site }) });
  return health;
}

beforeEach(async () => {
  clock = new FakeClock();
  repos = new InMemoryRepositories();
  hosts = new FakeProbeHosts();
  host = new FakeTemplateHost(ID);
  hosts.running.set(ID, host);
  bus = new RecordingEventBus<DomainEvents>();
  logger = new CollectingLogger();
  changed = [];
  signedOut = [];
  prober = GENERIC_PROBER;
  await repos.templates.insert(templateRecord());
  await repos.templateSites.upsert(
    templateSiteRecord({ siteId: 'site-a.test', learnedCookieNames: ['sid'], addedAt: 1 }),
  );
  await repos.templateSites.upsert(
    templateSiteRecord({ siteId: 'site-b.test', learnedCookieNames: ['sid'], addedAt: 2 }),
  );
});

function payloads<N extends keyof DomainEvents>(name: N): DomainEvents[N][] {
  // The bus records the payload published under `name`, which is `DomainEvents[N]`.
  return bus.published.filter((p) => p.name === name).map((p) => p.payload as DomainEvents[N]);
}

async function site(siteId: string): Promise<TemplateSiteRecord | undefined> {
  return (await repos.templateSites.list(ID)).find((s) => s.siteId === siteId);
}

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
    return 'resolved';
  } catch (err) {
    return isAppError(err) ? err.code : 'other';
  }
}

describe('a probe run', () => {
  it('writes one probe row per site and updates health', async () => {
    host.cookies = [fakeCookie('.site-a.test', 'sid')];
    const run = await service().probe(ID, { trigger: 'manual', start: 'never' });
    expect(run).toEqual([
      { siteId: 'site-a.test', outcome: 'signed_in', reason: 'learned_cookies', durationMs: 0 },
      { siteId: 'site-b.test', outcome: 'signed_out', reason: 'cookies_absent', durationMs: 0 },
    ]);
    expect(repos.templateProbes.rows).toMatchObject([
      { siteId: 'site-a.test', outcome: 'signed_in', trigger: 'manual', finalUrl: null },
      { siteId: 'site-b.test', outcome: 'signed_out', trigger: 'manual', finalUrl: null },
    ]);
    expect((await site('site-a.test'))?.health).toEqual({
      state: 'signed_in',
      reason: 'learned_cookies',
      checkedAt: clock.now(),
      changedAt: clock.now(),
      consecutiveInconclusive: 0,
    });
    expect((await site('site-b.test'))?.health.state).toBe('signed_out');
  });

  it('records how long each site took', async () => {
    prober = {
      async probe(ctx) {
        await clock.advance(1_234);
        return GENERIC_PROBER.probe(ctx);
      },
    };
    const run = await service().probe(ID, {
      trigger: 'schedule',
      siteIds: ['site-a.test'],
      start: 'never',
    });
    expect(run?.[0]?.durationMs).toBe(1_234);
    expect(repos.templateProbes.rows[0]).toMatchObject({ durationMs: 1_234, trigger: 'schedule' });
  });

  it('publishes template.probe and template.health with a transition only on a change', async () => {
    host.cookies = [fakeCookie('.site-a.test', 'sid')];
    const health = service();
    await health.probe(ID, { trigger: 'manual', start: 'never' });
    expect(payloads('template.probe').map((p) => p.probe)).toMatchObject([
      { seq: 1, site_id: 'site-a.test', outcome: 'signed_in', trigger: 'manual', duration_ms: 0 },
      { seq: 2, site_id: 'site-b.test', outcome: 'signed_out', trigger: 'manual' },
    ]);
    const first = payloads('template.health');
    expect(first).toHaveLength(2);
    expect(first[0]?.site.health.state).toBe('signed_in');
    expect(first[0]?.transition).toEqual({
      template: { name: 'job-hunt', display_name: 'Job hunt' },
      provider: 'site-a.test',
      covers: ['site-a.test'],
      from: 'unknown',
      to: 'signed_in',
      reason: 'learned_cookies',
      provider_signed_in: true,
      machine: 'studio-mac',
      at: clock.now(),
    });
    expect(first[1]?.transition).toMatchObject({
      from: 'unknown',
      to: 'signed_out',
      provider_signed_in: false,
    });
    expect(changed).toEqual([ID, ID]);

    bus.published.length = 0;
    await clock.advance(60_000);
    await health.probe(ID, { trigger: 'manual', start: 'never' });
    const again = payloads('template.health');
    expect(again).toHaveLength(2);
    expect(again.every((p) => p.transition === undefined)).toBe(true);
    expect(again[0]?.site.health.checked_at).toBe(clock.now());
    expect(changed).toEqual([ID, ID]);
  });

  it('a site signed in again reports provider_signed_in', async () => {
    const health = service();
    await health.probe(ID, { trigger: 'manual', siteIds: ['site-b.test'], start: 'never' });
    host.cookies = [fakeCookie('site-b.test', 'sid')];
    bus.published.length = 0;
    await health.probe(ID, { trigger: 'relogin', siteIds: ['site-b.test'], start: 'never' });
    expect(payloads('template.health')[0]?.transition).toMatchObject({
      from: 'signed_out',
      to: 'signed_in',
      provider_signed_in: true,
    });
  });

  it('calls the signed-out hook on a transition to signed_out only', async () => {
    const health = service();
    host.cookies = [fakeCookie('.site-a.test', 'sid')];
    await health.probe(ID, { trigger: 'manual', siteIds: ['site-a.test'], start: 'never' });
    expect(signedOut).toEqual([]);
    host.cookies = [];
    await health.probe(ID, { trigger: 'manual', siteIds: ['site-a.test'], start: 'never' });
    expect(
      signedOut.map((s) => [s.template.templateId, s.site.siteId, s.site.health.state]),
    ).toEqual([[ID, 'site-a.test', 'signed_out']]);
    await health.probe(ID, { trigger: 'manual', siteIds: ['site-a.test'], start: 'never' });
    expect(signedOut).toHaveLength(1);
  });

  it('a hook that throws is logged, not raised', async () => {
    const health = service();
    health.attach({
      signedOut: () => {
        throw new Error('boom');
      },
    });
    await health.probe(ID, { trigger: 'manual', siteIds: ['site-a.test'], start: 'never' });
    expect(logger.records.some((r) => r.msg === 'signed-out hook failed')).toBe(true);
  });

  it('a prober that throws counts inconclusive (network)', async () => {
    prober = {
      probe: () => Promise.reject(new Error('page crashed')),
    };
    const run = await service().probe(ID, {
      trigger: 'manual',
      siteIds: ['site-a.test'],
      start: 'never',
    });
    expect(run).toMatchObject([{ outcome: 'inconclusive', reason: 'network' }]);
    expect((await site('site-a.test'))?.health).toMatchObject({
      state: 'inconclusive',
      consecutiveInconclusive: 1,
    });
    expect(logger.records.some((r) => r.level === 'warn' && r.msg === 'probe failed')).toBe(true);
  });

  it('waits the gap between sites and stops when the signal aborts', async () => {
    const health = service();
    const run = health.probe(ID, { trigger: 'schedule', start: 'never', gapMs: () => 7_000 });
    await until(() => clock.pendingSleeps === 1);
    expect(repos.templateProbes.rows).toHaveLength(1);
    await clock.advance(7_000);
    expect(await run).toHaveLength(2);

    const controller = new AbortController();
    controller.abort();
    const none = await health.probe(ID, {
      trigger: 'schedule',
      start: 'never',
      signal: controller.signal,
    });
    expect(none).toEqual([]);
  });
});

describe('sites and start modes', () => {
  it('an unknown site is VALIDATION_FAILED; www. names the site', async () => {
    const health = service();
    expect(
      await codeOf(health.probe(ID, { trigger: 'manual', siteIds: ['nope.test'], start: 'never' })),
    ).toBe('VALIDATION_FAILED');
    const run = await health.probe(ID, {
      trigger: 'manual',
      siteIds: ['www.site-b.test', 'site-b.test'],
      start: 'never',
    });
    expect(run?.map((r) => r.siteId)).toEqual(['site-b.test']);
  });

  it('an unknown template is TEMPLATE_NOT_FOUND', async () => {
    expect(await codeOf(service().probe('tp-missing', { trigger: 'manual', start: 'never' }))).toBe(
      'TEMPLATE_NOT_FOUND',
    );
  });

  it('only enabled sites by default; no sites → an empty run without a browser', async () => {
    await repos.templateSites.upsert(
      templateSiteRecord({ siteId: 'site-b.test', learnedCookieNames: ['sid'], enabled: false }),
    );
    hosts.running.clear();
    const health = service();
    expect(await health.probe(ID, { trigger: 'manual', start: 'never' })).toBeNull();
    await repos.templateSites.upsert(templateSiteRecord({ siteId: 'site-a.test', enabled: false }));
    expect(await health.probe(ID, { trigger: 'manual', start: 'always' })).toEqual([]);
    expect(hosts.starts).toEqual([]);
  });

  it("'never' without a running browser skips (null) and writes nothing", async () => {
    hosts.running.clear();
    expect(await service().probe(ID, { trigger: 'host_start', start: 'never' })).toBeNull();
    expect(repos.templateProbes.rows).toEqual([]);
    expect(hosts.starts).toEqual([]);
  });

  it("'if_slot_free' skips without a free slot and starts with one", async () => {
    hosts.running.clear();
    hosts.free = false;
    const health = service();
    expect(await health.probe(ID, { trigger: 'schedule', start: 'if_slot_free' })).toBeNull();
    expect(hosts.starts).toEqual([]);
    hosts.free = true;
    expect(await health.probe(ID, { trigger: 'schedule', start: 'if_slot_free' })).toHaveLength(2);
    expect(hosts.starts).toEqual([ID]);
  });

  it("'always' starts the browser through withHost even without a free slot", async () => {
    hosts.running.clear();
    hosts.free = false;
    expect(await service().probe(ID, { trigger: 'manual', start: 'always' })).toHaveLength(2);
    expect(hosts.starts).toEqual([ID]);
  });

  it("'always' passes a start refusal through", async () => {
    hosts.running.clear();
    hosts.failStart = new Error('no slot');
    expect(await codeOf(service().probe(ID, { trigger: 'manual', start: 'always' }))).toBe('other');
  });

  it('a running browser is used whatever the start mode', async () => {
    hosts.free = false;
    expect(await service().probe(ID, { trigger: 'schedule', start: 'if_slot_free' })).toHaveLength(
      2,
    );
    expect(hosts.starts).toEqual([]);
  });
});

describe('serialization and record()', () => {
  it('runs of one template are serialized: a second probe waits for the first', async () => {
    const gate = deferred<ProbeVerdict>();
    const calls: string[] = [];
    prober = {
      probe: (ctx) => {
        calls.push(ctx.site.siteId);
        return calls.length === 1 ? gate.promise : GENERIC_PROBER.probe(ctx);
      },
    };
    const health = service();
    const first = health.probe(ID, { trigger: 'manual', siteIds: ['site-a.test'], start: 'never' });
    const second = health.probe(ID, {
      trigger: 'manual',
      siteIds: ['site-b.test'],
      start: 'never',
    });
    await until(() => calls.length === 1);
    for (let i = 0; i < 50; i++) await Promise.resolve();
    expect(calls).toEqual(['site-a.test']);
    expect(health.probing(ID)).toBe(true);
    gate.resolve({ outcome: 'signed_in', reason: 'learned_cookies', finalUrl: null });
    await Promise.all([first, second]);
    expect(calls).toEqual(['site-a.test', 'site-b.test']);
    expect(health.probing(ID)).toBe(false);
    await health.settled(ID);
  });

  it('a failed run does not block the next one', async () => {
    hosts.running.clear();
    hosts.failStart = new Error('start failed');
    const health = service();
    const failing = health.probe(ID, { trigger: 'manual', start: 'always' });
    const next = health.probe(ID, { trigger: 'manual', start: 'never' });
    expect(await codeOf(failing)).toBe('other');
    expect(await next).toBeNull();
    expect(health.probing(ID)).toBe(false);
  });

  it('record() writes a probe row with its trigger and applies it', async () => {
    const health = service();
    const template = templateRecord();
    await health.record(
      template,
      'site-b.test',
      { outcome: 'signed_in', reason: 'relogin', finalUrl: null },
      'relogin',
    );
    expect(repos.templateProbes.rows).toMatchObject([
      { siteId: 'site-b.test', outcome: 'signed_in', trigger: 'relogin', durationMs: 0 },
    ]);
    expect((await site('site-b.test'))?.health.state).toBe('signed_in');
    expect(payloads('template.health')[0]?.transition).toMatchObject({ to: 'signed_in' });
    expect(changed).toEqual([ID]);
  });

  it('record() of a removed site writes nothing', async () => {
    await service().record(
      templateRecord(),
      'gone.test',
      { outcome: 'signed_in', reason: 'relogin', finalUrl: null },
      'relogin',
    );
    expect(repos.templateProbes.rows).toEqual([]);
    expect(bus.published).toEqual([]);
  });
});
