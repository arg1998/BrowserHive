/** @module interface/http/routes/site-packs-classify.test — the T3b site-pack REST surface over the real app (spec 13 §11.1, §12): `GET /site-packs/strategies` from the binary's strategy table, a classified diff, and Apply and Revert refused with `SITE_PACK_BELOW_FLOOR` as problem+json naming the templates. */

import { describe, expect, it } from 'bun:test';
import {
  ProblemDetails,
  SitePackDiffResponse,
  SiteStrategiesResponse,
} from '@browserhive/contracts/http';
import { STRATEGY_IDS } from '@browserhive/contracts/site-packs';
import { createHttpKit } from '../../../../test/helpers/http-kit.ts';
import { packSha, sitePack } from '../../../../test/helpers/site-pack-kit.ts';
import { templateRecord, templateSiteRecord } from '../../../../test/persistence/helpers.ts';

async function kitWithPending(extra: Parameters<typeof sitePack>[2]) {
  const kit = await createHttpKit();
  const cookie = await kit.login();
  const registry = kit.sitePacks.registry;
  await registry.approveSite('pack-a.test', packSha(sitePack('pack-a.test', 1)), 'admin');
  await kit.repos.templates.insert(templateRecord({ name: 'sales', stealth: 'standard' }));
  await kit.repos.templateSites.upsert(
    templateSiteRecord({ siteId: 'pack-a.test', packId: 'pack-a.test', packVersion: 1 }),
  );
  kit.sitePacks.bundled.put(sitePack('pack-a.test', 2, extra));
  await registry.reload();
  return { kit, cookie };
}

describe('GET /site-packs/strategies', () => {
  it('lists every strategy of the binary with its parameters', async () => {
    const kit = await createHttpKit();
    const response = await kit.request('GET', '/api/v1/site-packs/strategies', {
      cookie: await kit.login(),
    });
    expect(response.status).toBe(200);
    const body = SiteStrategiesResponse.parse(await response.json());
    expect(body.data.map((s) => s.id)).toEqual([...STRATEGY_IDS]);
    const spacing = body.data.find((s) => s.id === 'launch-spacing');
    expect(spacing?.params[0]).toEqual({
      name: 'min_gap_s',
      type: 'integer',
      default: null,
      default_from: 'pacing.min_launch_gap_s',
      fallback: 0,
      min: 0,
      max: 3600,
      values: null,
      safe_direction: 'up',
      safe_value: null,
    });
    const webrtc = body.data.find((s) => s.id === 'webrtc-policy')?.params[0];
    expect(webrtc).toMatchObject({
      type: 'enum',
      safe_direction: 'toward',
      safe_value: 'disable_non_proxied_udp',
    });
    const warmup = body.data.find((s) => s.id === 'entry-warmup')?.params[0];
    expect(warmup).toMatchObject({ name: 'path', type: 'path', safe_direction: 'none' });
  });
});

describe('a classified diff and the stealth floor over REST', () => {
  it('GET …/diff carries the classification and each change’s class', async () => {
    const { kit, cookie } = await kitWithPending({ guards: [] });
    const response = await kit.request('GET', '/api/v1/site-packs/pack-a.test/diff?to=2', {
      cookie,
    });
    const diff = SitePackDiffResponse.parse(await response.json());
    expect(diff.classification).toBe('loosening');
    expect(diff.changes).toEqual([
      expect.objectContaining({ path: 'guards[logout]', class: 'loosening' }),
    ]);
  });

  it('Apply above a using template’s floor is 409 SITE_PACK_BELOW_FLOOR naming the template', async () => {
    const { kit, cookie } = await kitWithPending({
      strategies: [{ id: 'stealth-profile', params: { min_level: 'max' } }],
    });
    const response = await kit.request('POST', '/api/v1/site-packs/pack-a.test/apply', {
      cookie,
      body: { version: 2 },
    });
    expect(response.status).toBe(409);
    const problem = ProblemDetails.parse(await response.json());
    expect(problem.code).toBe('SITE_PACK_BELOW_FLOOR');
    expect(problem.details).toMatchObject({
      pack_id: 'pack-a.test',
      version: 2,
      templates: [{ name: 'sales', issues: [{ code: 'stealth_below_floor' }] }],
    });
    expect(problem.detail ?? problem.title).toBeDefined();
    expect(kit.sitePacks.registry.get('pack-a.test')?.pending[0]?.classification).toBe(
      'restrictive',
    );
  });

  it('Revert to a version whose floor is above a using template is 409 SITE_PACK_BELOW_FLOOR', async () => {
    const kit = await createHttpKit();
    const cookie = await kit.login();
    const registry = kit.sitePacks.registry;
    const v1 = sitePack('pack-a.test', 1, {
      strategies: [{ id: 'stealth-profile', params: { min_level: 'max' } }],
    });
    kit.sitePacks.bundled.put(v1);
    await registry.reload();
    await registry.approveSite('pack-a.test', packSha(v1), 'admin');
    kit.sitePacks.bundled.put(sitePack('pack-a.test', 2));
    await registry.reload();
    await registry.apply('pack-a.test', 2, 'admin');
    // A `standard` template adds the site under v2, which has no floor.
    await kit.repos.templates.insert(templateRecord({ name: 'sales', stealth: 'standard' }));
    await kit.repos.templateSites.upsert(
      templateSiteRecord({ siteId: 'pack-a.test', packId: 'pack-a.test', packVersion: 2 }),
    );
    await registry.refreshUsage();
    const response = await kit.request('POST', '/api/v1/site-packs/pack-a.test/revert', {
      cookie,
    });
    expect(response.status).toBe(409);
    const problem = ProblemDetails.parse(await response.json());
    expect(problem.code).toBe('SITE_PACK_BELOW_FLOOR');
    expect(problem.details).toMatchObject({
      pack_id: 'pack-a.test',
      version: 1,
      templates: [{ name: 'sales', issues: [{ code: 'stealth_below_floor' }] }],
    });
    expect(registry.effectiveFor('pack-a.test')?.version).toBe(2);
  });
});
