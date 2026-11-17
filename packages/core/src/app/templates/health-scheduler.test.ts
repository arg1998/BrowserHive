/** @module app/templates/health-scheduler.test — the probe schedule on a fake clock with a deterministic `random` (spec 13 §8.3): first ticks, intervals with ±10 % jitter, the 5–20 s site gap, at most two templates probing at once, skipped runs retried, and the host-start, restore and attention triggers. */

import { beforeEach, describe, expect, it } from 'bun:test';
import { CollectingLogger } from '../../../test/helpers/collecting-logger.ts';
import { FakeClock } from '../../../test/helpers/fake-clock.ts';
import { until } from '../../../test/helpers/fake-probe-hosts.ts';
import { InMemoryRepositories } from '../../../test/helpers/in-memory-repos.ts';
import { templateRecord, templateSiteRecord } from '../../../test/persistence/helpers.ts';
import { UNKNOWN_SITE_HEALTH } from '../../ports/persistence/index.ts';
import { HealthScheduler, MAX_PROBING_HOSTS } from './health-scheduler.ts';
import type { ProbeOptions, ProbeRun, TemplateHealthService } from './template-health.ts';

const HOUR = 3_600_000;
const INTERVAL = 6 * HOUR;

interface Call {
  readonly templateId: string;
  readonly options: ProbeOptions;
  readonly finish: (run: ProbeRun) => void;
  readonly fail: (err: Error) => void;
}

/** A health service whose probe runs the test finishes; `auto` answers at once. */
class FakeHealth implements Pick<TemplateHealthService, 'probe' | 'probing'> {
  readonly calls: Call[] = [];
  readonly busy = new Set<string>();
  auto: ProbeRun | 'hold' = [];

  probe(templateId: string, options: ProbeOptions): Promise<ProbeRun> {
    let finish: (run: ProbeRun) => void = () => undefined;
    let fail: (err: Error) => void = () => undefined;
    const promise = new Promise<ProbeRun>((resolve, reject) => {
      finish = resolve;
      fail = reject;
    });
    this.calls.push({ templateId, options, finish, fail });
    if (this.auto !== 'hold') finish(this.auto);
    return promise;
  }

  probing(templateId: string): boolean {
    return this.busy.has(templateId);
  }

  ids(): string[] {
    return this.calls.map((c) => c.templateId);
  }
}

let clock: FakeClock;
let repos: InMemoryRepositories;
let health: FakeHealth;
let random: number;
let scheduler: HealthScheduler;
let logger: CollectingLogger;

async function addTemplate(
  id: string,
  name: string,
  checkedAt: number | null,
  patch: Parameters<typeof templateRecord>[0] = {},
): Promise<void> {
  await repos.templates.insert(
    templateRecord({ templateId: id, name, healthIntervalMs: INTERVAL, ...patch }),
  );
  await repos.templateSites.upsert(
    templateSiteRecord({
      templateId: id,
      siteId: 'site-a.test',
      health: { ...UNKNOWN_SITE_HEALTH, checkedAt },
    }),
  );
}

beforeEach(() => {
  clock = new FakeClock();
  repos = new InMemoryRepositories();
  health = new FakeHealth();
  random = 0.5;
  logger = new CollectingLogger();
  scheduler = new HealthScheduler({
    repos,
    health,
    clock,
    random: () => random,
    logger,
  });
});

describe('scheduled probes', () => {
  it('the first tick probes templates with a site never checked; others wait an interval', async () => {
    const t0 = clock.now();
    await addTemplate('tp-a', 'a', null);
    await addTemplate('tp-b', 'b', t0 - HOUR);
    await scheduler.tick();
    expect(health.ids()).toEqual(['tp-a']);
    expect(health.calls[0]?.options).toMatchObject({ trigger: 'schedule', start: 'if_slot_free' });
    // random 0.5 → exactly the interval.
    expect(scheduler.dueAt('tp-a')).toBe(t0 + INTERVAL);
    expect(scheduler.dueAt('tp-b')).toBe(t0 - HOUR + INTERVAL);

    await clock.advance(INTERVAL - HOUR - 1);
    await scheduler.tick();
    expect(health.ids()).toEqual(['tp-a']);
    await clock.advance(1);
    await scheduler.tick();
    expect(health.ids()).toEqual(['tp-a', 'tp-b']);
    await clock.advance(HOUR);
    await scheduler.tick();
    expect(health.ids()).toEqual(['tp-a', 'tp-b', 'tp-a']);
  });

  it('jitters the next due time by ±10 %', async () => {
    const t0 = clock.now();
    await addTemplate('tp-a', 'a', null);
    random = 0;
    await scheduler.tick();
    expect(scheduler.dueAt('tp-a')).toBe(t0 + INTERVAL * 0.9);
    await clock.advance(INTERVAL * 0.9);
    random = 0.999_999;
    await scheduler.tick();
    const due = scheduler.dueAt('tp-a') ?? 0;
    expect(due - clock.now()).toBeGreaterThan(INTERVAL * 1.099);
    expect(due - clock.now()).toBeLessThanOrEqual(INTERVAL * 1.1);
  });

  it('spaces sites 5–20 s apart through gapMs', async () => {
    await addTemplate('tp-a', 'a', null);
    await scheduler.tick();
    const gap = health.calls[0]?.options.gapMs;
    random = 0;
    expect(gap?.()).toBe(5_000);
    random = 0.5;
    expect(gap?.()).toBe(12_500);
    random = 0.999_999_9;
    expect(gap?.()).toBe(20_000);
  });

  it(`probes at most ${MAX_PROBING_HOSTS} templates at once; a third waits for a later tick`, async () => {
    await addTemplate('tp-a', 'a', null);
    await addTemplate('tp-b', 'b', null);
    await addTemplate('tp-c', 'c', null);
    health.auto = 'hold';
    const first = scheduler.tick();
    await until(() => health.calls.length === 2);
    expect(health.ids()).toEqual(['tp-a', 'tp-b']);
    expect(scheduler.running()).toEqual(['tp-a', 'tp-b']);
    // A tick while both still run starts nothing.
    const second = scheduler.tick();
    await second;
    expect(health.ids()).toEqual(['tp-a', 'tp-b']);
    for (const call of health.calls) call.finish([]);
    await first;
    expect(scheduler.running()).toEqual([]);
    health.auto = [];
    await scheduler.tick();
    expect(health.ids()).toEqual(['tp-a', 'tp-b', 'tp-c']);
  });

  it('a skipped run (no slot) is retried at the next interval', async () => {
    const t0 = clock.now();
    await addTemplate('tp-a', 'a', null);
    health.auto = null;
    await scheduler.tick();
    expect(scheduler.dueAt('tp-a')).toBe(t0 + INTERVAL);
    await clock.advance(HOUR);
    await scheduler.tick();
    expect(health.calls).toHaveLength(1);
    await clock.advance(INTERVAL - HOUR);
    await scheduler.tick();
    expect(health.calls).toHaveLength(2);
  });

  it('a failed run is retried at the next interval and never throws', async () => {
    const t0 = clock.now();
    await addTemplate('tp-a', 'a', null);
    health.auto = 'hold';
    const tick = scheduler.tick();
    await until(() => health.calls.length === 1);
    health.calls[0]?.fail(new Error('boom'));
    await tick;
    expect(scheduler.dueAt('tp-a')).toBe(t0 + INTERVAL);
    expect(scheduler.running()).toEqual([]);
    expect(logger.records.some((r) => r.msg === 'scheduled probe failed')).toBe(true);
  });

  it('disabled and recording templates, and templates without enabled sites, are not probed', async () => {
    await addTemplate('tp-a', 'a', null, { status: 'disabled' });
    await addTemplate('tp-b', 'b', null, { status: 'recording' });
    await addTemplate('tp-c', 'c', null);
    await repos.templateSites.upsert(
      templateSiteRecord({ templateId: 'tp-c', siteId: 'site-a.test', enabled: false }),
    );
    await scheduler.tick();
    expect(health.calls).toEqual([]);
  });

  it('forgets a deleted template', async () => {
    await addTemplate('tp-a', 'a', null);
    await scheduler.tick();
    expect(scheduler.dueAt('tp-a')).toBeDefined();
    await repos.templates.remove('tp-a');
    await scheduler.tick();
    expect(scheduler.dueAt('tp-a')).toBeUndefined();
  });
});

describe('event triggers', () => {
  it('hostStarted probes every site without starting a browser', () => {
    scheduler.hostStarted('tp-a');
    expect(health.calls[0]).toMatchObject({
      templateId: 'tp-a',
      options: { trigger: 'host_start', start: 'never' },
    });
  });

  it('hostStarted is skipped while the template is probing', () => {
    health.busy.add('tp-a');
    scheduler.hostStarted('tp-a');
    expect(health.calls).toEqual([]);
  });

  it('hostStarted is skipped right after a probe of the template', async () => {
    await addTemplate('tp-a', 'a', null);
    await scheduler.tick();
    await clock.advance(59_999);
    scheduler.hostStarted('tp-a');
    expect(health.calls).toHaveLength(1);
    await clock.advance(1);
    scheduler.hostStarted('tp-a');
    expect(health.calls).toHaveLength(2);
    scheduler.hostStarted('tp-a');
    expect(health.calls).toHaveLength(2);
  });

  it('restored probes when a slot is free; attentionResolved only on a running browser', () => {
    scheduler.restored('tp-a');
    scheduler.attentionResolved('tp-b');
    expect(health.calls.map((c) => [c.templateId, c.options.trigger, c.options.start])).toEqual([
      ['tp-a', 'restore', 'if_slot_free'],
      ['tp-b', 'attention', 'never'],
    ]);
  });

  it('a trigger whose probe fails is logged, not raised', async () => {
    health.auto = 'hold';
    scheduler.restored('tp-a');
    health.calls[0]?.fail(new Error('gone'));
    await until(() => logger.records.some((r) => r.msg === 'probe failed'));
    expect(logger.records.find((r) => r.msg === 'probe failed')?.fields).toMatchObject({
      templateId: 'tp-a',
      trigger: 'restore',
    });
  });
});
