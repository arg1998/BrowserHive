/** @module interface/http/routes/template-recording — recording a template's sign-ins and the T1a host routes (spec 13 §7.1, §11.1): start, **I'm signed in**, Finish, Cancel, remove an unlisted sign-in, clear saved passwords and autofill. */

import {
  ConfirmRecordingRequest,
  ConfirmRecordingResponse,
  FinishRecordingRequest,
  FinishRecordingResponse,
  RemoveSignInResponse,
  StartRecordingRequest,
  StartRecordingResponse,
  TemplateDomainParams,
  TemplateIdParams,
  TemplateOkResponse,
} from '@browserhive/contracts/http';
import { defineRoute, reply } from '../define-route.ts';
import { requirePrincipal } from './common.ts';

const tags = ['templates'];
/** Opening windows on the BrowserHive machine is rate limited (spec 13 §11.1). */
const RECORDING_RATE = { limit: 6, windowMs: 60_000, key: 'principal' } as const;

/** Recording and host routes. */
export const TEMPLATE_RECORDING_ROUTES = [
  defineRoute({
    operationId: 'removeTemplateSignIn',
    tags,
    summary:
      "Remove a sign-in that is not a site of the template (an unlisted sign-in): the domain's cookies and site data in the template's browser.",
    request: { params: TemplateDomainParams },
    responses: { 200: RemoveSignInResponse },
    errors: ['TEMPLATE_NOT_FOUND'],
    async handler({ input, principal, services }) {
      const { domain: _domain, ...removed } = await services.templateRecording.removeSignIn(
        input.params.template_id,
        input.params.domain,
        requirePrincipal(principal).subject,
      );
      return reply(200, { ok: true as const, ...removed });
    },
  }),
  defineRoute({
    operationId: 'startTemplateRecording',
    tags,
    summary:
      "Open the sign-in window on the machine running BrowserHive: one tab per site, agents' windows minimized meanwhile. An open recording is returned again and its window raised.",
    request: { params: TemplateIdParams, body: StartRecordingRequest },
    responses: { 200: StartRecordingResponse },
    errors: ['TEMPLATE_NOT_FOUND', 'TEMPLATE_DISABLED', 'SESSION_LIMIT_REACHED'],
    rateLimit: RECORDING_RATE,
    async handler({ input, principal, services }) {
      const request = input.body.sites === undefined ? {} : { sites: input.body.sites };
      return reply(
        200,
        await services.templateRecording.start(input.params.template_id, request, {
          subject: requirePrincipal(principal).subject,
        }),
      );
    },
  }),
  defineRoute({
    operationId: 'confirmTemplateRecording',
    tags,
    summary:
      "I'm signed in, for a site without a pack: the cookie names that appeared on it since the window opened (analytics excluded) become its learned sign-in cookies.",
    request: { params: TemplateIdParams, body: ConfirmRecordingRequest },
    responses: { 200: ConfirmRecordingResponse },
    errors: ['TEMPLATE_NOT_FOUND', 'CONFLICT'],
    async handler({ input, principal, services }) {
      const site = await services.templateRecording.confirm(
        input.params.template_id,
        input.body.site_id,
        requirePrincipal(principal).subject,
      );
      return reply(200, { site });
    },
  }),
  defineRoute({
    operationId: 'finishTemplateRecording',
    tags,
    summary:
      'Finish: remove the chosen unlisted sign-ins, mark sites not confirmed signed out, set the template ready and close the window.',
    request: { params: TemplateIdParams, body: FinishRecordingRequest },
    responses: { 200: FinishRecordingResponse },
    errors: ['TEMPLATE_NOT_FOUND', 'CONFLICT'],
    async handler({ input, principal, services }) {
      const request =
        input.body.remove_sign_ins === undefined
          ? {}
          : { removeSignIns: input.body.remove_sign_ins };
      return reply(
        200,
        await services.templateRecording.finish(
          input.params.template_id,
          request,
          requirePrincipal(principal).subject,
        ),
      );
    },
  }),
  defineRoute({
    operationId: 'cancelTemplateRecording',
    tags,
    summary: 'Close the sign-in window; the template stays in recording (setting up).',
    request: { params: TemplateIdParams },
    responses: { 200: TemplateOkResponse },
    errors: ['TEMPLATE_NOT_FOUND'],
    async handler({ input, principal, services }) {
      await services.templateRecording.cancel(
        input.params.template_id,
        requirePrincipal(principal).subject,
      );
      return reply(200, { ok: true as const });
    },
  }),
  defineRoute({
    operationId: 'clearTemplateProfileSecrets',
    tags,
    summary:
      "Empty the saved passwords and autofill data found in the template's browser profile; its browser stops (its sessions close) and starts again on the next use.",
    request: { params: TemplateIdParams },
    responses: { 200: TemplateOkResponse },
    errors: ['TEMPLATE_NOT_FOUND'],
    async handler({ input, principal, services }) {
      await services.templateRecording.clearProfileSecrets(
        input.params.template_id,
        requirePrincipal(principal).subject,
      );
      return reply(200, { ok: true as const });
    },
  }),
];
