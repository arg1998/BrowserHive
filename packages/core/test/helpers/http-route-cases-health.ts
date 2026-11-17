/** @module test/helpers/http-route-cases-health — the route cases of the T2 template routes (spec 13 §8, §11.1): probes, re-login, Show window, Let agents continue and the vault link. */

import { type CaseContext, type RouteCase, template } from './http-route-case-types.ts';

const api = (path: string) => `/api/v1${path}`;
const tpl = (path: string) => (ctx: CaseContext) =>
  api(`/templates/${ctx.state['template'] ?? ''}${path}`);

/** The T2 routes (the kit answers them with `FakeTemplateHealth`). */
export const TEMPLATE_HEALTH_CASES: readonly RouteCase[] = [
  {
    operationId: 'probeTemplate',
    setup: template,
    success: { method: 'POST', path: tpl('/probe'), body: {}, status: 200 },
    invalid: { method: 'POST', path: tpl('/probe'), body: { site_ids: [] } },
  },
  {
    operationId: 'listTemplateProbes',
    setup: template,
    success: { path: tpl('/probes?outcome=signed_out'), status: 200 },
    invalid: { path: tpl('/probes?outcome=maybe') },
  },
  {
    operationId: 'startTemplateRelogin',
    setup: template,
    success: {
      method: 'POST',
      path: tpl('/relogin'),
      body: { site_id: 'site-a.test' },
      status: 200,
    },
    invalid: {
      method: 'POST',
      path: tpl('/relogin'),
      body: { site_id: 'site-a.test', method: 'fax' },
    },
  },
  {
    operationId: 'confirmTemplateRelogin',
    setup: template,
    success: {
      method: 'POST',
      path: tpl('/relogin/confirm'),
      body: { site_id: 'site-a.test' },
      status: 200,
    },
    invalid: { method: 'POST', path: tpl('/relogin/confirm'), body: {} },
  },
  {
    operationId: 'cancelTemplateRelogin',
    setup: template,
    success: { method: 'DELETE', path: tpl('/relogin'), status: 200 },
    invalid: { method: 'DELETE', path: api('/templates/bad/relogin') },
  },
  {
    operationId: 'showTemplateWindow',
    setup: template,
    success: { method: 'POST', path: tpl('/host/show'), status: 200 },
    invalid: { method: 'POST', path: api('/templates/bad/host/show') },
  },
  {
    operationId: 'continueTemplateAgents',
    setup: template,
    success: { method: 'POST', path: tpl('/agents/continue'), status: 200 },
    invalid: { method: 'POST', path: api('/templates/bad/agents/continue') },
  },
  {
    operationId: 'putTemplateReloginLink',
    setup: template,
    success: {
      method: 'PUT',
      path: tpl('/sites/site-a.test/relogin'),
      body: {
        vault_handle: 'github',
        auto_relogin: true,
        form: { username: '#user', password: '#pass', path: '/login' },
      },
      status: 200,
    },
    invalid: {
      method: 'PUT',
      path: tpl('/sites/site-a.test/relogin'),
      body: { vault_handle: 'github', form: { username: '#u', password: '#p', path: 'login?x' } },
    },
  },
];
