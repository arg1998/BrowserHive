/** @module app/templates/template-prelaunch.test — the pre-launch health check (spec 13 §8.2) over the real health service and a fake host jar: only stale sites are probed, concurrent launches share one probe, unfinished probes count inconclusive, and `TEMPLATE_NEEDS_LOGIN` only when every enabled site is out. */

import { beforeEach, describe, expect, it } from 'bun:test';
import { CollectingLogger } from '../../../test/helpers/collecting-logger.ts';
import { FakeClock } from '../../../test/helpers/fake-clock.ts';
import { deferred, FakeProbeHosts, until } from '../../../test/helpers/fake-probe-hosts.ts';
import { FakeTemplateHost, fakeCookie } from '../../../test/helpers/fake-template-host.ts';
import { InMemoryRepositories } from '../../../test/helpers/in-memory-repos.ts';
import { templateRecord, templateSiteRecord } from '../../../test/persistence/helpers.ts';
import type { ProbeVerdict } from '../../domain/templates/probe.ts';
import { type AppError, isAppError } from '../../kernel/errors/app-error.ts';
import type { TemplateHealthState, TemplateRecord } from '../../ports/persistence/index.ts';
import { GENERIC_PROBER, type SiteProber } from './site-prober.ts';
import { type ProbeOptions, TemplateHealthService } from './template-health.ts';
import { needsLogin, PRELAUNCH_MAX_AGE_MS, PrelaunchCheck } from './template-prelaunch.ts';

const TEMPLATE = templateRecord();
const ID = TEMPLATE.templateId;
const MIN = 60_000;

let clock: FakeClock;
let repos: InMemoryRepositories;
let host: FakeTemplateHost;
let prober: SiteProber;
let probes: ProbeOptions[];
let check: PrelaunchCheck;

async function addSite(
  siteId: string,
  state: TemplateHealthState,
  ageMs: number | null,
  enabled = true,
): Promise<void> {
  const checkedAt = ageMs === null ? null : clock.now() - ageMs;
  await repos.templateSites.upsert(
    templateSiteRecord({
      siteId,
      enabled,
      learnedCookieNames: ['sid'],
      health: { state, reason: null, checkedAt, changedAt: checkedAt, consecutiveInconclusive: 0 },
    }),
  );
}

beforeEach(async () => {
  clock = new FakeClock();
  repos = new InMemoryRepositories();
  host = new FakeTemplateHost(ID);
  const hosts = new FakeProbeHosts();
  hosts.running.set(ID, host);
  prober = GENERIC_PROBER;
  probes = [];
  const health = new TemplateHealthService({
    repos,
    hosts,
    clock,
    logger: new CollectingLogger(),
    machine: 'studio-mac',
    probers: () => ({ probe: (ctx) => prober.probe(ctx) }),
  });
  check = new PrelaunchCheck({
    repos,
    clock,
    health: {
      probe: (templateId, options) => {
        probes.push(options);
        return health.probe(templateId, options);
      },
    },
  });
  await repos.templates.insert(TEMPLATE);
});

async function refusal(promise: Promise<unknown>): Promise<AppError | null> {
  try {
    await promise;
    return null;
  } catch (err) {
    if (isAppError(err)) return err;
    throw err;
  }
}

describe('which sites a launch probes', () => {
  it('probes only enabled sites older than 15 min, without starting a browser', async () => {
    host.cookies = [fakeCookie('.site-a.test', 'sid'), fakeCookie('.site-c.test', 'sid')];
    await addSite('site-a.test', 'signed_out', PRELAUNCH_MAX_AGE_MS + 1);
    await addSite('site-b.test', 'signed_in', PRELAUNCH_MAX_AGE_MS);
    await addSite('site-c.test', 'unknown', null);
    await addSite('site-d.test', 'signed_out', 99 * MIN, false);
    const result = await check.check(TEMPLATE);
    expect(probes).toEqual([
      { trigger: 'prelaunch', siteIds: ['site-a.test', 'site-c.test'], start: 'never' },
    ]);
    expect(result).toEqual({
      sites: [
        { site: 'site-a.test', status: 'signed_in' },
        { site: 'site-b.test', status: 'signed_in' },
        { site: 'site-c.test', status: 'signed_in' },
      ],
      out: [],
    });
  });

  it('fresh sites are not probed; their stored state is the answer', async () => {
    await addSite('site-a.test', 'signed_in', MIN);
    await addSite('site-b.test', 'signed_out', MIN);
    const result = await check.check(TEMPLATE);
    expect(probes).toEqual([]);
    expect(result.out).toEqual(['site-b.test']);
  });

  it('concurrent checks of one template share one probe (single-flight)', async () => {
    const gate = deferred<ProbeVerdict>();
    let calls = 0;
    prober = {
      probe: () => {
        calls += 1;
        return gate.promise;
      },
    };
    await addSite('site-a.test', 'unknown', null);
    await addSite('site-b.test', 'signed_in', MIN);
    const first = check.check(TEMPLATE);
    const second = check.check(TEMPLATE);
    await until(() => calls === 1);
    expect(probes).toHaveLength(1);
    gate.resolve({ outcome: 'signed_in', reason: 'learned_cookies', finalUrl: null });
    const [a, b] = await Promise.all([first, second]);
    expect(a).toEqual(b);
    expect(a.sites[0]).toEqual({ site: 'site-a.test', status: 'signed_in' });
    expect(calls).toBe(1);
    // The flight is over: the next stale launch probes again.
    await clock.advance(PRELAUNCH_MAX_AGE_MS + 1);
    prober = GENERIC_PROBER;
    host.cookies = [fakeCookie('.site-a.test', 'sid')];
    await check.check(TEMPLATE);
    expect(probes).toHaveLength(2);
  });
});

describe('the budget', () => {
  it('sites not probed within the budget count inconclusive for this launch', async () => {
    const gate = deferred<ProbeVerdict>();
    prober = { probe: () => gate.promise };
    await addSite('site-a.test', 'signed_out', PRELAUNCH_MAX_AGE_MS + MIN);
    await addSite('site-b.test', 'signed_out', MIN);
    const launch = check.check(TEMPLATE, undefined, 10_000);
    await until(() => clock.pendingSleeps === 1);
    await clock.advance(10_000);
    // Every site's stored state is signed out, but site-a's probe did not finish: no refusal.
    expect(await launch).toEqual({
      sites: [
        { site: 'site-a.test', status: 'inconclusive' },
        { site: 'site-b.test', status: 'signed_out' },
      ],
      out: ['site-b.test'],
    });
    gate.resolve({ outcome: 'signed_out', reason: 'cookies_absent', finalUrl: null });
  });

  it('an aborted launch stops waiting', async () => {
    const gate = deferred<ProbeVerdict>();
    prober = { probe: () => gate.promise };
    await addSite('site-a.test', 'signed_out', null);
    const controller = new AbortController();
    const launch = check.check(TEMPLATE, controller.signal);
    await until(() => clock.pendingSleeps === 1);
    controller.abort();
    expect((await launch).sites).toEqual([{ site: 'site-a.test', status: 'inconclusive' }]);
    gate.resolve({ outcome: 'signed_out', reason: 'cookies_absent', finalUrl: null });
  });
});

describe('TEMPLATE_NEEDS_LOGIN', () => {
  it('only when every enabled site is signed out or challenged', async () => {
    await addSite('site-a.test', 'signed_out', null);
    await addSite('site-b.test', 'challenged', MIN);
    await addSite('site-c.test', 'signed_in', MIN, false);
    const err = await refusal(check.check(TEMPLATE));
    expect(err?.code).toBe('TEMPLATE_NEEDS_LOGIN');
    expect(err?.details).toEqual({
      template: 'job-hunt',
      sites: ['site-a.test', 'site-b.test'],
      sites_text: 'site-a.test, site-b.test',
    });
    expect(err?.publicMessage).toBe(
      "Template 'job-hunt' is signed out of site-a.test, site-b.test. The operator has been asked to sign in again; retry after that.",
    );
  });

  it('not when one enabled site is signed in or undecided', async () => {
    await addSite('site-a.test', 'signed_out', MIN);
    await addSite('site-b.test', 'inconclusive', MIN);
    expect(await check.check(TEMPLATE)).toMatchObject({ out: ['site-a.test'] });
    await addSite('site-b.test', 'unknown', MIN);
    expect(await refusal(check.check(TEMPLATE))).toBeNull();
  });

  it('not for a template without enabled sites', async () => {
    await addSite('site-a.test', 'signed_out', MIN, false);
    expect(await check.check(TEMPLATE)).toEqual({ sites: [], out: [] });
  });

  it('prelaunch_check off: no probe and no refusal', async () => {
    await addSite('site-a.test', 'signed_out', null);
    const off: TemplateRecord = { ...TEMPLATE, prelaunchCheck: false };
    const result = await check.check(off);
    expect(probes).toEqual([]);
    expect(result).toEqual({
      sites: [{ site: 'site-a.test', status: 'signed_out' }],
      out: ['site-a.test'],
    });
  });

  it('needsLogin is agent-facing (the template name, never an id)', () => {
    const err = needsLogin('job-hunt', ['site-a.test']);
    expect(err.publicMessage).toContain("Template 'job-hunt' is signed out of site-a.test.");
    expect(err.publicMessage).not.toContain(ID);
  });
});
