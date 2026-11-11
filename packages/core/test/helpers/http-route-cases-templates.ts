/** @module test/helpers/http-route-cases-templates — the route cases of the T1b template routes (spec 13 §11.1): edit, disable/enable, sites, the browser, versions, restore and seed operations, the access tester and the reveal. */

import { FakeTemplateHost, fakeCookie } from './fake-template-host.ts';
import { type CaseContext, type RouteCase, template } from './http-route-case-types.ts';

const api = (path: string) => `/api/v1${path}`;
const tpl = (path: string) => (ctx: CaseContext) =>
  api(`/templates/${ctx.state['template'] ?? ''}${path}`);

/** A template with a running (fake) browser holding one cookie. */
async function running(ctx: CaseContext): Promise<void> {
  await template(ctx);
  const host = new FakeTemplateHost(ctx.state['template'] ?? '');
  host.cookies = [fakeCookie('.site-a.test', 'sid')];
  ctx.kit.templateOps.host = host;
}

/** A template with version 1 written from its browser. */
async function versioned(ctx: CaseContext): Promise<void> {
  await running(ctx);
  await ctx.kit.templateState
    .saveVersion(ctx.state['template'] ?? '', { reason: 'manual', by: 'admin' })
    .catch(() => undefined);
}

/** A seed operation started. */
async function operation(ctx: CaseContext): Promise<void> {
  await running(ctx);
  const response = await ctx.kit.request(
    'POST',
    api(`/templates/${ctx.state['template'] ?? ''}/state`),
    {
      cookie: ctx.cookie,
      body: { cookies: [], origins: [] },
    },
  );
  const body = (await response.json()) as { operation_id?: string };
  ctx.state['operation'] = body.operation_id ?? 'op-000000000000';
}

/** A template with two sites. */
async function twoSites(ctx: CaseContext): Promise<void> {
  await template(ctx);
  await ctx.kit.request('PUT', api(`/templates/${ctx.state['template'] ?? ''}/sites/site-b.test`), {
    cookie: ctx.cookie,
    body: {},
  });
}

const STORAGE_STATE = {
  cookies: [{ name: 'sid', value: 'v', domain: '.site-a.test', path: '/', expires: -1 }],
  origins: [],
};

/** T1b routes. */
export const TEMPLATE_OPS_CASES: readonly RouteCase[] = [
  {
    operationId: 'getTemplateOperation',
    setup: operation,
    success: {
      path: (ctx) => api(`/templates/operations/${ctx.state['operation'] ?? ''}`),
      status: 200,
    },
    invalid: { path: api('/templates/operations/bad') },
  },
  {
    operationId: 'updateTemplate',
    setup: template,
    success: {
      method: 'PATCH',
      path: tpl(''),
      body: { display_name: 'Job hunt', policy: { max_concurrent: 3 } },
      status: 200,
    },
    invalid: { method: 'PATCH', path: tpl(''), body: { stealth: 'off' } },
  },
  {
    operationId: 'disableTemplate',
    setup: template,
    success: { method: 'POST', path: tpl('/disable'), status: 200 },
    invalid: { method: 'POST', path: api('/templates/bad/disable') },
  },
  {
    operationId: 'enableTemplate',
    setup: template,
    success: { method: 'POST', path: tpl('/enable'), status: 200 },
    invalid: { method: 'POST', path: api('/templates/bad/enable') },
  },
  {
    operationId: 'putTemplateSite',
    setup: template,
    success: {
      method: 'PUT',
      path: tpl('/sites/site-b.test'),
      body: { write_policy: 'confirm' },
      status: 200,
    },
    invalid: { method: 'PUT', path: tpl('/sites/site-b.test'), body: { write_policy: 'nope' } },
  },
  {
    operationId: 'deleteTemplateSite',
    setup: twoSites,
    success: { method: 'DELETE', path: tpl('/sites/site-b.test'), status: 200 },
    invalid: { method: 'DELETE', path: tpl('/sites/BAD_SITE!') },
  },
  {
    operationId: 'seedTemplate',
    setup: running,
    success: { method: 'POST', path: tpl('/state'), body: STORAGE_STATE, status: 202 },
    invalid: { method: 'POST', path: tpl('/state'), body: { cookies: 'x' } },
  },
  {
    operationId: 'startTemplateHost',
    setup: template,
    success: { method: 'POST', path: tpl('/host/start'), status: 200 },
    invalid: { method: 'POST', path: api('/templates/bad/host/start') },
  },
  {
    operationId: 'stopTemplateHost',
    setup: template,
    success: { method: 'POST', path: tpl('/host/stop'), status: 200 },
    invalid: { method: 'POST', path: api('/templates/bad/host/stop') },
  },
  {
    operationId: 'restartTemplateHost',
    setup: template,
    success: { method: 'POST', path: tpl('/host/restart'), status: 200 },
    invalid: { method: 'POST', path: api('/templates/bad/host/restart') },
  },
  {
    operationId: 'closeTemplatePage',
    setup: async (ctx) => {
      await template(ctx);
      ctx.kit.templateOps.parkedTargets = ['T1'];
    },
    success: { method: 'POST', path: tpl('/host/pages/T1/close'), status: 200 },
    invalid: { method: 'POST', path: api('/templates/bad/host/pages/T1/close') },
  },
  {
    operationId: 'listTemplateVersions',
    setup: versioned,
    success: { path: tpl('/versions'), status: 200 },
    invalid: { path: tpl('/versions?limit=0') },
  },
  {
    operationId: 'saveTemplateVersion',
    setup: running,
    success: { method: 'POST', path: tpl('/versions'), status: 200 },
    invalid: { method: 'POST', path: api('/templates/bad/versions') },
  },
  {
    operationId: 'restoreTemplateVersion',
    setup: versioned,
    success: {
      method: 'POST',
      path: tpl('/versions/1/restore'),
      body: { force_close: true },
      status: 202,
    },
    invalid: { method: 'POST', path: tpl('/versions/zero/restore'), body: {} },
  },
  {
    operationId: 'updateTemplateVersion',
    setup: versioned,
    success: { method: 'PATCH', path: tpl('/versions/1'), body: { pinned: true }, status: 200 },
    invalid: { method: 'PATCH', path: tpl('/versions/1'), body: { pinned: 'yes' } },
  },
  {
    operationId: 'resolveTemplateAccess',
    setup: template,
    success: {
      method: 'POST',
      path: tpl('/access/resolve'),
      body: { principal: 'agent-a', harness: 'claude-code' },
      status: 200,
    },
    invalid: { method: 'POST', path: tpl('/access/resolve'), body: { harness: 'Not A Slug' } },
  },
  {
    operationId: 'revealTemplateDataDir',
    setup: template,
    success: { method: 'POST', path: tpl('/data-dir/reveal'), status: 200 },
    invalid: { method: 'POST', path: api('/templates/bad/data-dir/reveal') },
  },
];
