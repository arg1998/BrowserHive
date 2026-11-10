/** @module interface/http/routes/templates.test — the T1a template routes over the real app (spec 13 §11.1): problem codes and statuses, the auth=token access rule, the detail and delete shapes. */

import { describe, expect, it } from 'bun:test';
import { ProblemDetails, TemplateDetailResponse, TemplatesPage } from '@browserhive/contracts/http';
import { createHttpKit } from '../../../../test/helpers/http-kit.ts';
import { TEMPLATE_BODY } from '../../../../test/helpers/http-route-cases.ts';

async function kitWithCookie() {
  const kit = await createHttpKit();
  return { kit, cookie: await kit.login() };
}

describe('template routes', () => {
  it('POST creates a recording template; a second POST with the name is 409 TEMPLATE_NAME_TAKEN', async () => {
    const { kit, cookie } = await kitWithCookie();
    const created = await kit.request('POST', '/api/v1/templates', { cookie, body: TEMPLATE_BODY });
    expect(created.status).toBe(201);
    const { template } = (await created.json()) as {
      template: { status: string; sites: { site_id: string }[]; owner: string };
    };
    expect(template.status).toBe('recording');
    expect(template.sites.map((s) => s.site_id)).toEqual(['site-a.test']);
    const again = await kit.request('POST', '/api/v1/templates', { cookie, body: TEMPLATE_BODY });
    expect(again.status).toBe(409);
    expect(ProblemDetails.parse(await again.json()).code).toBe('TEMPLATE_NAME_TAKEN');
  });

  it('under auth=token, creating without authorized_principals is 400 VALIDATION_FAILED', async () => {
    const { kit, cookie } = await kitWithCookie();
    const response = await kit.request('POST', '/api/v1/templates', {
      cookie,
      body: { name: 'job-hunt', sites: [{ site_id: 'site-a.test' }] },
    });
    expect(response.status).toBe(400);
    const problem = ProblemDetails.parse(await response.json());
    expect(problem.code).toBe('VALIDATION_FAILED');
    expect(JSON.stringify(problem)).toContain('policy.authorized_principals');
  });

  it('refuses inline proxy credentials and a reserved password variable with field errors', async () => {
    const { kit, cookie } = await kitWithCookie();
    for (const proxy of [
      { server: 'http://u:p@proxy.test:8080' },
      { server: 'http://proxy.test:8080', password_env: 'BROWSERHIVE_PROXY' },
    ]) {
      const response = await kit.request('POST', '/api/v1/templates', {
        cookie,
        body: { ...TEMPLATE_BODY, proxy, locale: 'en-CA', timezone_id: 'America/Toronto' },
      });
      expect(response.status).toBe(400);
      expect(ProblemDetails.parse(await response.json()).code).toBe('VALIDATION_FAILED');
    }
  });

  it('GET lists and reads; unknown ids are 404 TEMPLATE_NOT_FOUND', async () => {
    const { kit, cookie } = await kitWithCookie();
    const created = await kit.request('POST', '/api/v1/templates', { cookie, body: TEMPLATE_BODY });
    const { template } = (await created.json()) as { template: { template_id: string } };
    const list = TemplatesPage.parse(
      await (await kit.request('GET', '/api/v1/templates', { cookie })).json(),
    );
    expect(list.data.map((t) => t.template_id)).toEqual([template.template_id]);
    const detail = TemplateDetailResponse.parse(
      await (
        await kit.request('GET', `/api/v1/templates/${template.template_id}`, { cookie })
      ).json(),
    );
    expect(detail.host.state).toBe('stopped');
    const missing = await kit.request('GET', '/api/v1/templates/tp-unknown000', { cookie });
    expect(missing.status).toBe(404);
    expect(ProblemDetails.parse(await missing.json()).code).toBe('TEMPLATE_NOT_FOUND');
  });

  it('DELETE with live sessions is 409 TEMPLATE_IN_USE until force=true', async () => {
    const { kit, cookie } = await kitWithCookie();
    const created = await kit.request('POST', '/api/v1/templates', { cookie, body: TEMPLATE_BODY });
    const { template } = (await created.json()) as { template: { template_id: string } };
    const id = template.template_id;
    kit.templateRuntime.sessions.set(id, ['jobs-11111111']);
    const busy = await kit.request('DELETE', `/api/v1/templates/${id}`, { cookie });
    expect(busy.status).toBe(409);
    expect(ProblemDetails.parse(await busy.json()).code).toBe('TEMPLATE_IN_USE');
    const forced = await kit.request('DELETE', `/api/v1/templates/${id}?force=true`, { cookie });
    expect(forced.status).toBe(200);
    expect(await forced.json()).toEqual({
      ok: true,
      closed_sessions: ['jobs-11111111'],
      deleted_bytes: 0,
    });
    expect((await kit.request('GET', `/api/v1/templates/${id}`, { cookie })).status).toBe(404);
  });
});
