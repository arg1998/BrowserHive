/** @module test/integration/site-pack-strategies-admission.test — spec 13 §17 T3b acceptance for the admission strategies on real headless Chromium through the MCP stack (`launch_session` with a template): `launch-spacing` waits then refuses, the pack concurrency cap and `ramp-up` lower the cap, `active-hours` answers `TEMPLATE_BUSY` with `retry_after_ms` while running sessions continue, the agent's text names no strategy, pack or site, and `sitePacks=false` disables every one; `stealth-profile` refuses a template below the floor at creation and site add over a real registry. */

import { afterEach, describe, expect, it } from 'bun:test';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { TemplateEditService } from '../../src/app/templates/template-edit.ts';
import { TemplateService } from '../../src/app/templates/template-service.ts';
import { localTime } from '../../src/domain/site-packs/active-hours.ts';
import { isAppError } from '../../src/kernel/errors/app-error.ts';
import type { Repositories } from '../../src/ports/persistence/index.ts';
import { CollectingLogger } from '../helpers/collecting-logger.ts';
import { FakeTemplateHostOps } from '../helpers/fake-host-ops.ts';
import { InMemoryUnitOfWork } from '../helpers/in-memory-repos.ts';
import { PacksLookup, strategyPack } from '../helpers/packs-lookup.ts';
import {
  createSitePackKit,
  makeDirs,
  packSha,
  removeDirs,
  type SitePackDirs,
  sitePack,
  writePack,
} from '../helpers/site-pack-kit.ts';
import {
  FAKE_TEMPLATE_GEO,
  FakeTemplateFiles,
  FakeTemplateRuntime,
  RecordingDegradations,
} from '../helpers/template-kit.ts';
import { templateRecord, templateSiteRecord } from '../persistence/helpers.ts';
import { HEADED } from './template-fixture.ts';
import { type TemplateMcp, templateMcp } from './template-mcp-fixture.ts';

const H = 3_600_000;

let world: TemplateMcp | null = null;
let dirs: SitePackDirs | null = null;
afterEach(async () => {
  await world?.stop();
  world = null;
  if (dirs !== null) removeDirs(dirs);
  dirs = null;
});

/** The typed error a failed call carries in `_meta`. */
function errorOf(result: CallToolResult): { code?: string; details?: Record<string, unknown> } {
  const meta = result._meta?.['browserhive.ai/error'];
  return typeof meta === 'object' && meta !== null ? meta : {};
}

function textOf(result: CallToolResult): string {
  return result.content.map((c) => (c.type === 'text' ? c.text : '')).join('\n');
}

/** A world whose supervisor reads `lookup` while `packs.on` (`sitePacks=false` when off). */
async function packsWorld(lookup: PacksLookup) {
  const packs = { on: true };
  world = await templateMcp('standard', {
    supervisor: { sitePacks: () => (packs.on ? lookup : null), random: () => 0 },
  });
  const w = world;
  const launch = (template = w.template.name, slug = 'adm') =>
    w.harness.call('launch_session', { slug, template });
  const idOf = (result: CallToolResult): string => {
    if (result.isError === true) throw new Error(textOf(result));
    const parsed: unknown = JSON.parse(textOf(result));
    const id = (parsed as { session_id?: unknown }).session_id;
    if (typeof id !== 'string') throw new Error('no session id');
    return id;
  };
  return { w, packs, launch, idOf };
}

/** The agent-facing text of a refusal says nothing about strategies, packs, sites or counts. */
function expectAgentSafe(result: CallToolResult): void {
  const text = textOf(result).toLowerCase();
  for (const word of ['spacing', 'pack', 'site-a', 'hours', 'ramp', 'concurrency', 'strategy']) {
    expect(text).not.toContain(word);
  }
  expect(text).toContain('at capacity');
}

describe('admission strategies on a real template host', () => {
  it('launch-spacing: a launch waits for its turn, one beyond 20 s is refused with retry_after_ms', async () => {
    const lookup = new PacksLookup([
      strategyPack('site-a.test', {
        strategies: [{ id: 'launch-spacing', params: { min_gap_s: 11, jitter_pct: 0 } }],
      }),
    ]);
    const { launch, idOf } = await packsWorld(lookup);
    const started = performance.now();
    const timed = (p: Promise<CallToolResult>) =>
      p.then((result) => ({ result, ms: performance.now() - started }));
    // Three launches at once: turns at 0, 11 and 22 s; the third is beyond the 20 s wait.
    const [first, second, third] = await Promise.all([
      timed(launch(undefined, 'one')),
      timed(launch(undefined, 'two')),
      timed(launch(undefined, 'three')),
    ]);
    if (first === undefined || second === undefined || third === undefined) throw new Error('no');
    idOf(first.result);
    idOf(second.result);
    expect(second.ms).toBeGreaterThanOrEqual(10_500);
    expect(third.result.isError).toBe(true);
    expect(errorOf(third.result).code).toBe('TEMPLATE_BUSY');
    const details = errorOf(third.result).details ?? {};
    expect(details['limit_kind']).toBe('capacity');
    expect(Number(details['retry_after_ms'])).toBeGreaterThan(20_000);
    expect(Number(details['retry_after_ms'])).toBeLessThanOrEqual(22_000);
    // Refused at once, not after waiting.
    expect(third.ms).toBeLessThan(5_000);
    expectAgentSafe(third.result);
  });

  it('concurrency and ramp-up lower the cap, active-hours refuses with retry_after_ms while running sessions continue, and sitePacks=false disables them all', async () => {
    const pack = strategyPack('site-a.test', {
      concurrency: { max_sessions: 2, source: { url: 'https://site-a.test/', kind: 'observed' } },
      strategies: [{ id: 'ramp-up', params: { days: 10, start_fraction: 0.2 } }],
    });
    const lookup = new PacksLookup([pack]);
    const { w, packs, launch, idOf } = await packsWorld(lookup);
    // A second, freshly created template: ramp-up gives it ceil(5 × 0.2) = 1 session.
    const young = templateRecord({
      templateId: 'tp-young00001',
      name: 'young',
      headless: !HEADED,
      maxConcurrent: 5,
      createdAt: Date.now(),
    });
    await w.harness.templates.repos.templates.insert(young);
    await w.harness.templates.repos.templateSites.upsert(
      templateSiteRecord({ templateId: young.templateId, siteId: 'site-a.test' }),
    );

    // The fixture template (created long ago, max_concurrent 5): the pack caps it at 2.
    const one = idOf(await launch(undefined, 'one'));
    idOf(await launch(undefined, 'two'));
    const capped = await launch(undefined, 'three');
    expect(errorOf(capped)).toMatchObject({
      code: 'TEMPLATE_BUSY',
      details: { limit_kind: 'capacity' },
    });
    expectAgentSafe(capped);
    idOf(await launch('young', 'y1'));
    const ramped = await launch('young', 'y2');
    expect(errorOf(ramped)).toMatchObject({ code: 'TEMPLATE_BUSY' });
    const summaries = await w.harness.templates.service.list({
      limit: 50,
      dir: 'asc',
      total: false,
      sort: 'name',
    });
    expect(summaries.data.find((t) => t.name === 'young')?.cap).toBe(1);

    // active-hours: a window opening two hours from now in the template's zone.
    const hour = localTime(Date.now(), w.template.identity.timezoneId).hour;
    lookup.set({
      ...pack,
      concurrency: undefined,
      strategies: [
        { id: 'active-hours', params: { start_hour: (hour + 2) % 24, end_hour: (hour + 4) % 24 } },
      ],
    });
    const outside = await launch(undefined, 'three');
    expect(errorOf(outside)).toMatchObject({
      code: 'TEMPLATE_BUSY',
      details: { limit_kind: 'capacity' },
    });
    const retry = Number(errorOf(outside).details?.['retry_after_ms']);
    expect(retry).toBeGreaterThan(H);
    expect(retry).toBeLessThanOrEqual(2 * H);
    expectAgentSafe(outside);
    // Running sessions continue.
    const nav = await w.harness.call('navigate', {
      session_id: one,
      url: w.sites.url('site-a.test'),
    });
    expect(nav.isError).not.toBe(true);

    // sitePacks=false: no hours, the template's own cap again.
    packs.on = false;
    idOf(await launch(undefined, 'three'));
    idOf(await launch('young', 'y2'));
    expect(w.supervisor.liveSessions(w.template.templateId)).toHaveLength(3);
  });
});

describe('the stealth floor over a real registry', () => {
  async function services(enabled: boolean) {
    dirs = makeDirs();
    const floor = {
      strategies: [{ id: 'stealth-profile' as const, params: { min_level: 'max' } }],
    };
    writePack(dirs.bundled, sitePack('site-a.test', 1, floor));
    const kit = createSitePackKit({ dirs, enabled });
    await kit.registry.reload();
    const repos: Repositories = { ...kit.repos, operatorActions: kit.actions };
    const runtime = new FakeTemplateRuntime();
    const logger = new CollectingLogger();
    const service = new TemplateService({
      repos,
      uow: new InMemoryUnitOfWork(repos),
      runtime,
      geo: FAKE_TEMPLATE_GEO,
      files: new FakeTemplateFiles(),
      degradations: new RecordingDegradations(),
      ids: { opaque: (n) => 'y'.repeat(n), eventId: () => kit.ids.eventId() },
      clock: kit.clock,
      logger,
      packs: kit.registry,
      config: {
        enabled: true,
        authMode: 'off',
        maxPagesPerHost: 40,
        defaults: { channel: 'chromium', stealth: 'standard', fingerprint: false, humanize: false },
      },
    });
    const edit = new TemplateEditService({
      repos,
      uow: new InMemoryUnitOfWork(repos),
      runtime,
      ops: new FakeTemplateHostOps(),
      sessions: { peek: () => undefined, close: () => Promise.resolve(true) },
      ids: kit.ids,
      clock: kit.clock,
      logger,
      changed: () => undefined,
      packs: kit.registry,
    });
    return { service, edit, sha: packSha(sitePack('site-a.test', 1, floor)) };
  }

  async function codes(promise: Promise<unknown>): Promise<string[]> {
    try {
      await promise;
      return [];
    } catch (error) {
      if (!isAppError(error)) throw error;
      const issues = (error.details as { issues?: { path: string; code: string }[] }).issues ?? [];
      return [error.code, ...issues.map((i) => `${i.path} ${i.code}`)];
    }
  }

  it('stealth-profile refuses a template below the floor at creation and site add', async () => {
    const { service, edit, sha } = await services(true);
    const sites = [{ site_id: 'site-a.test', pack_sha256: sha }];
    expect(await codes(service.create({ name: 'low', sites }, 'op'))).toEqual([
      'VALIDATION_FAILED',
      'sites[0] stealth_below_floor',
    ]);
    expect(await codes(service.create({ name: 'high', sites, stealth: 'max' }, 'op'))).toEqual([]);
    const generic = await service.create({ name: 'g', sites: [{ site_id: 'x.test' }] }, 'op');
    expect(
      await codes(edit.putSite(generic.template_id, 'site-a.test', { pack_sha256: sha }, 'op')),
    ).toEqual(['VALIDATION_FAILED', 'site_id stealth_below_floor']);
  });

  it('sitePacks=false checks no floor', async () => {
    const { service } = await services(false);
    expect(
      await codes(service.create({ name: 'low', sites: [{ site_id: 'site-a.test' }] }, 'op')),
    ).toEqual([]);
  });
});
