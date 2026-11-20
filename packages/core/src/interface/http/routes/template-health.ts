/** @module interface/http/routes/template-health — template health and re-login (spec 13 §8, §11.1, PR T2): **Check now**, the probe history, re-login by window or vault, **I'm signed in**, **Show window**, **Let agents continue** and the vault link for auto-relogin. */

import {
  CancelReloginQuery,
  ConfirmReloginRequest,
  ContinueAgentsResponse,
  ProbeTemplateRequest,
  ProbeTemplateResponse,
  PutReloginLinkRequest,
  PutReloginLinkResponse,
  ReloginResponse,
  ShowTemplateWindowResponse,
  StartReloginRequest,
  TemplateIdParams,
  TemplateProbesPage,
  TemplateProbesQuery,
  TemplateReloginSiteParams,
} from '@browserhive/contracts/http';
import { authorizer } from '../../../domain/auth/authorizer.ts';
import { defineRoute, reply } from '../define-route.ts';
import { requirePrincipal } from './common.ts';

const tags = ['templates'];
/** Probes and windows on the BrowserHive machine are rate limited (spec 13 §11.1). */
const WINDOW_RATE = { limit: 6, windowMs: 60_000, key: 'principal' } as const;

/** Health and re-login routes. */
export const TEMPLATE_HEALTH_ROUTES = [
  defineRoute({
    operationId: 'probeTemplate',
    tags,
    summary:
      "Check now: probe the template's sites (every enabled site, or the ones given), starting its browser when it is stopped; waits at most 120 s.",
    request: { params: TemplateIdParams, body: ProbeTemplateRequest },
    responses: { 200: ProbeTemplateResponse },
    errors: [
      'TEMPLATE_NOT_FOUND',
      'TEMPLATE_DISABLED',
      'VALIDATION_FAILED',
      'SESSION_LIMIT_REACHED',
    ],
    rateLimit: WINDOW_RATE,
    async handler({ input, principal, services }) {
      return reply(
        200,
        await services.templateHealth.probe(
          input.params.template_id,
          input.body.site_ids,
          requirePrincipal(principal).subject,
        ),
      );
    },
  }),
  defineRoute({
    operationId: 'listTemplateProbes',
    tags,
    summary:
      "The template's probe history, newest first, filterable by site, outcome, trigger and time.",
    request: { params: TemplateIdParams, query: TemplateProbesQuery },
    responses: { 200: TemplateProbesPage },
    errors: ['TEMPLATE_NOT_FOUND'],
    async handler({ input, services }) {
      return reply(
        200,
        await services.templateHealth.probes(input.params.template_id, input.query),
      );
    },
  }),
  defineRoute({
    operationId: 'startTemplateRelogin',
    tags,
    summary:
      "Re-login a site: `window` opens a window at the site on the machine running BrowserHive (the template's agents wait meanwhile unless let_agents_continue); `vault` fills the linked vault binding in the background as template:<id>.",
    request: { params: TemplateIdParams, body: StartReloginRequest },
    responses: { 200: ReloginResponse },
    errors: [
      'TEMPLATE_NOT_FOUND',
      'TEMPLATE_DISABLED',
      'VALIDATION_FAILED',
      'CONFLICT',
      'SESSION_LIMIT_REACHED',
    ],
    rateLimit: WINDOW_RATE,
    async handler({ input, principal, services }) {
      return reply(
        200,
        await services.templateHealth.startRelogin(
          input.params.template_id,
          {
            siteId: input.body.site_id,
            method: input.body.method,
            letAgentsContinue: input.body.let_agents_continue,
          },
          { subject: requirePrincipal(principal).subject },
        ),
      );
    },
  }),
  defineRoute({
    operationId: 'confirmTemplateRelogin',
    tags,
    summary:
      "I'm signed in, for a site without a pack: the cookie names that appeared on it since the re-login window opened become its learned sign-in cookies, and the re-login finishes. With requested_at, only that re-login (409 when another replaced it).",
    request: { params: TemplateIdParams, body: ConfirmReloginRequest },
    responses: { 200: ReloginResponse },
    errors: ['TEMPLATE_NOT_FOUND', 'VALIDATION_FAILED', 'CONFLICT'],
    async handler({ input, principal, services }) {
      return reply(
        200,
        await services.templateHealth.confirmRelogin(
          input.params.template_id,
          input.body.site_id,
          requirePrincipal(principal).subject,
          input.body.requested_at,
        ),
      );
    },
  }),
  defineRoute({
    operationId: 'cancelTemplateRelogin',
    tags,
    summary:
      'Cancel the queued or open re-login: its window closes and agents continue. With requested_at, only that re-login (409 when another replaced it).',
    request: { params: TemplateIdParams, query: CancelReloginQuery },
    responses: { 200: ReloginResponse },
    errors: ['TEMPLATE_NOT_FOUND', 'CONFLICT'],
    async handler({ input, principal, services }) {
      return reply(
        200,
        await services.templateHealth.cancelRelogin(
          input.params.template_id,
          requirePrincipal(principal).subject,
          input.query.requested_at,
        ),
      );
    },
  }),
  defineRoute({
    operationId: 'showTemplateWindow',
    tags,
    summary:
      'Show window: open the re-login window a notification button queued, or raise the open re-login or recording window, on the machine running BrowserHive.',
    request: { params: TemplateIdParams },
    responses: { 200: ShowTemplateWindowResponse },
    errors: ['TEMPLATE_NOT_FOUND', 'CONFLICT', 'SESSION_LIMIT_REACHED'],
    rateLimit: WINDOW_RATE,
    async handler({ input, principal, services }) {
      return reply(
        200,
        await services.templateHealth.show(input.params.template_id, {
          subject: requirePrincipal(principal).subject,
        }),
      );
    },
  }),
  defineRoute({
    operationId: 'continueTemplateAgents',
    tags,
    summary:
      "Let agents continue: the template's launches and tool calls stop waiting for the open sign-in window (D-60).",
    request: { params: TemplateIdParams },
    responses: { 200: ContinueAgentsResponse },
    errors: ['TEMPLATE_NOT_FOUND', 'CONFLICT'],
    async handler({ input, principal, services }) {
      return reply(
        200,
        await services.templateHealth.continueAgents(
          input.params.template_id,
          requirePrincipal(principal).subject,
        ),
      );
    },
  }),
  defineRoute({
    operationId: 'putTemplateReloginLink',
    tags,
    summary:
      "Link a vault binding to a site for auto-relogin (also needs vault:write): the binding, the auto-relogin switch, the sign-in form, and Allow this template (adds template:<id> to the binding's principals, widening who can use the credential).",
    request: { params: TemplateReloginSiteParams, body: PutReloginLinkRequest },
    responses: { 200: PutReloginLinkResponse },
    errors: [
      'TEMPLATE_NOT_FOUND',
      'VALIDATION_FAILED',
      'FORBIDDEN',
      'VAULT_NOT_CONFIGURED',
      'CONFLICT',
    ],
    async handler({ input, principal, services }) {
      // Linking a credential needs the vault's write scope as well as `templates:login` (§6.2).
      authorizer.assertCan(principal, 'vault:write');
      const body = input.body;
      return reply(
        200,
        await services.templateHealth.putLink(
          input.params.template_id,
          input.params.site_id,
          {
            vaultHandle: body.vault_handle,
            ...(body.auto_relogin !== undefined && { autoRelogin: body.auto_relogin }),
            ...(body.form !== undefined && {
              form:
                body.form === null
                  ? null
                  : {
                      username: body.form.username,
                      password: body.form.password,
                      ...(body.form.submit !== undefined && { submit: body.form.submit }),
                      ...(body.form.next !== undefined && { next: body.form.next }),
                      ...(body.form.path !== undefined && { path: body.form.path }),
                    },
            }),
            allowTemplate: body.allow_template,
          },
          requirePrincipal(principal).subject,
        ),
      );
    },
  }),
];
