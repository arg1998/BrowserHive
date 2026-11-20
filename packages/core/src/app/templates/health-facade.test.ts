/** @module app/templates/health-facade.test — **Check now**'s 120 s cap (spec 13 §11.1, review #81 L-4): it bounds a run queued behind another, a slow browser start and the sites themselves; past it the answer holds what finished and says `cut_short`, and a run still queued never starts. */

import { beforeEach, describe, expect, it } from 'bun:test';
import { CollectingLogger } from '../../../test/helpers/collecting-logger.ts';
import { FakeClock } from '../../../test/helpers/fake-clock.ts';
import { FakeIdGenerator } from '../../../test/helpers/fake-id-generator.ts';
import { deferred, FakeProbeHosts, until } from '../../../test/helpers/fake-probe-hosts.ts';
import { FakeTemplateHost, fakeCookie } from '../../../test/helpers/fake-template-host.ts';
import { InMemoryRepositories } from '../../../test/helpers/in-memory-repos.ts';
import { InMemoryOperatorActionRepository } from '../../../test/helpers/in-memory-vault-repos.ts';
import { templateRecord, templateSiteRecord } from '../../../test/persistence/helpers.ts';
import type { ProbeVerdict } from '../../domain/templates/probe.ts';
import type { TemplateRecord } from '../../ports/persistence/index.ts';
import type { TemplateHost } from '../../ports/template-host.ts';
import { PROBE_ROUTE_WAIT_MS, TemplateHealthFacade } from './health-facade.ts';
import type { ReloginLinks } from './relogin-link.ts';
import { GENERIC_PROBER, type SiteProber } from './site-prober.ts';
import { TemplateHealthService } from './template-health.ts';
import type { TemplateReloginService } from './template-relogin.ts';

const ID = templateRecord().templateId;

/** Probe hosts whose browser start waits for `gate` when one is set. */
class SlowStartHosts extends FakeProbeHosts {
  gate: Promise<void> | null = null;

  override async withHost<T>(
    template: TemplateRecord,
    fn: (host: TemplateHost) => Promise<T>,
  ): Promise<T> {
    if (this.gate !== null) await this.gate;
    return super.withHost(template, fn);
  }
}

let clock: FakeClock;
let repos: InMemoryRepositories;
let actions: InMemoryOperatorActionRepository;
let hosts: SlowStartHosts;
let prober: SiteProber;
let health: TemplateHealthService;
let facade: TemplateHealthFacade;

beforeEach(async () => {
  clock = new FakeClock();
  repos = new InMemoryRepositories();
  actions = new InMemoryOperatorActionRepository();
  hosts = new SlowStartHosts();
  const host = new FakeTemplateHost(ID);
  host.cookies = [fakeCookie('.site-a.test', 'sid'), fakeCookie('.site-b.test', 'sid')];
  hosts.running.set(ID, host);
  prober = GENERIC_PROBER;
  await repos.templates.insert(templateRecord());
  for (const [i, siteId] of ['site-a.test', 'site-b.test'].entries()) {
    await repos.templateSites.upsert(
      templateSiteRecord({ siteId, learnedCookieNames: ['sid'], addedAt: i }),
    );
  }
  health = new TemplateHealthService({
    repos,
    hosts,
    clock,
    logger: new CollectingLogger(),
    machine: 'studio-mac',
    probers: () => prober,
  });
  facade = new TemplateHealthFacade({
    repos: {
      templates: repos.templates,
      templateProbes: repos.templateProbes,
      operatorActions: actions,
    },
    health,
    relogin: {} as TemplateReloginService,
    links: {} as ReloginLinks,
    ids: new FakeIdGenerator(),
    clock,
  });
});

const manualRows = () => repos.templateProbes.rows.filter((r) => r.trigger === 'manual');

describe('Check now (review #81 L-4)', () => {
  it('a check that finishes in time is not cut short', async () => {
    const answer = await facade.probe(ID, undefined, 'op');
    expect(answer.cut_short).toBe(false);
    expect(answer.results.map((r) => r.site_id)).toEqual(['site-a.test', 'site-b.test']);
  });

  it('queued behind a slow scheduled run: answers at the cap, and the queued run never starts', async () => {
    const gate = deferred<ProbeVerdict>();
    let calls = 0;
    prober = {
      probe: (ctx) => (++calls === 1 ? gate.promise : GENERIC_PROBER.probe(ctx)),
    };
    const scheduled = health.probe(ID, { trigger: 'schedule', start: 'never' });
    await until(() => calls === 1);
    const answer = facade.probe(ID, undefined, 'op');
    await until(() => clock.pendingSleeps > 0);
    await clock.advance(PROBE_ROUTE_WAIT_MS);
    expect(await answer).toEqual({ results: [], cut_short: true });
    gate.resolve({ outcome: 'signed_in', reason: 'learned_cookies', finalUrl: null });
    await scheduled;
    await health.settled(ID);
    expect(manualRows()).toEqual([]);
    expect(actions.rows.at(-1)?.details).toMatchObject({ cut_short: true });
  });

  it('a slow browser start is bounded too', async () => {
    hosts.running.clear();
    const started = deferred();
    hosts.gate = started.promise;
    const answer = facade.probe(ID, undefined, 'op');
    await until(() => clock.pendingSleeps > 0);
    await clock.advance(PROBE_ROUTE_WAIT_MS);
    expect(await answer).toEqual({ results: [], cut_short: true });
    started.resolve();
    await health.settled(ID);
    // The run saw the abort once the browser was there: no site was probed for it.
    expect(manualRows()).toEqual([]);
  });

  it('a site still running at the cap: the answer keeps the sites checked by then', async () => {
    const stuck = deferred<ProbeVerdict>();
    prober = {
      probe: (ctx) =>
        ctx.site.siteId === 'site-b.test' ? stuck.promise : GENERIC_PROBER.probe(ctx),
    };
    const answer = facade.probe(ID, undefined, 'op');
    await until(() => clock.pendingSleeps > 0);
    await until(() => manualRows().length === 1);
    await clock.advance(PROBE_ROUTE_WAIT_MS);
    const result = await answer;
    expect(result.cut_short).toBe(true);
    expect(result.results).toEqual([
      { site_id: 'site-a.test', outcome: 'signed_in', reason: 'learned_cookies', duration_ms: 0 },
    ]);
    stuck.resolve({ outcome: 'inconclusive', reason: 'timeout', finalUrl: null });
    await health.settled(ID);
  });
});
