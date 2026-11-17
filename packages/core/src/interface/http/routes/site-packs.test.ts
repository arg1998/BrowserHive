/** @module interface/http/routes/site-packs.test — site-pack REST behaviour over the real app (review #83): a template site whose pack needs approval is refused without `pack_sha256` and names the offer (S-M4), on create and on `PUT …/sites`; unknown query parameters are refused (S-L3); a local file claiming another pack's domain is 409 naming it (S-M1). */

import { describe, expect, it } from 'bun:test';
import { ProblemDetails } from '@browserhive/contracts/http';
import { createHttpKit } from '../../../../test/helpers/http-kit.ts';
import { packSha, sitePack } from '../../../../test/helpers/site-pack-kit.ts';

const PACK = sitePack('pack-a.test', 1);

async function kitWithCookie() {
  const kit = await createHttpKit();
  return { kit, cookie: await kit.login() };
}

function body(site: Record<string, unknown>) {
  return { name: 'jobs', sites: [site], policy: { authorized_principals: [] } };
}

describe('first use over REST (review #83 S-M4)', () => {
  it('POST /templates without pack_sha256 for a pack that needs approval is 409 with the offer', async () => {
    const { kit, cookie } = await kitWithCookie();
    const refused = await kit.request('POST', '/api/v1/templates', {
      cookie,
      body: body({ site_id: 'www.pack-a.test' }),
    });
    expect(refused.status).toBe(409);
    const problem = ProblemDetails.parse(await refused.json());
    expect(problem.code).toBe('SITE_PACK_APPROVAL_REQUIRED');
    expect(problem.details).toMatchObject({
      pack_id: 'pack-a.test',
      version: 1,
      sha256: packSha(PACK),
    });
    expect(kit.sitePacks.registry.get('pack-a.test')?.approved).toBeNull();

    const created = await kit.request('POST', '/api/v1/templates', {
      cookie,
      body: body({ site_id: 'www.pack-a.test', pack_sha256: packSha(PACK) }),
    });
    expect(created.status).toBe(201);
    expect(kit.sitePacks.registry.get('pack-a.test')?.approved?.version).toBe(1);
  });

  it('PUT …/sites/{site_id} without pack_sha256 is refused the same way', async () => {
    const { kit, cookie } = await kitWithCookie();
    const created = await kit.request('POST', '/api/v1/templates', {
      cookie,
      body: body({ site_id: 'site-a.test' }),
    });
    const { template } = (await created.json()) as { template: { template_id: string } };
    const path = `/api/v1/templates/${template.template_id}/sites/pack-a.test`;
    const refused = await kit.request('PUT', path, { cookie, body: {} });
    expect(refused.status).toBe(409);
    expect(ProblemDetails.parse(await refused.json()).code).toBe('SITE_PACK_APPROVAL_REQUIRED');
    const added = await kit.request('PUT', path, { cookie, body: { pack_sha256: packSha(PACK) } });
    expect(added.status).toBe(200);
  });
});

describe('site-pack routes', () => {
  it('list routes refuse unknown query parameters (review #83 S-L3)', async () => {
    const { kit, cookie } = await kitWithCookie();
    for (const path of ['/site-packs', '/site-packs/changes', '/site-packs/guard-hits']) {
      const response = await kit.request('GET', `/api/v1${path}?bogus=1`, { cookie });
      expect(response.status).toBe(400);
    }
  });

  it('approve-local of content taking an approved pack’s domain is 409 naming it (S-M1)', async () => {
    const { kit, cookie } = await kitWithCookie();
    await kit.sitePacks.registry.approveSite('pack-a.test', packSha(PACK), 'admin');
    const evil = sitePack('evil.test', 1, { domains: ['evil.test', 'pack-a.test'], guards: [] });
    kit.sitePacks.local.put(evil);
    await kit.sitePacks.registry.reload();
    const response = await kit.request('POST', '/api/v1/site-packs/evil.test/approve-local', {
      cookie,
      body: { sha256: packSha(evil) },
    });
    expect(response.status).toBe(409);
    const problem = ProblemDetails.parse(await response.json());
    expect(problem.code).toBe('SITE_PACK_DOMAIN_TAKEN');
    expect(problem.details).toEqual({
      pack_id: 'evil.test',
      domain: 'pack-a.test',
      owner: 'pack-a.test',
    });
    expect(kit.sitePacks.registry.effectiveFor('pack-a.test')?.packId).toBe('pack-a.test');
  });
});
