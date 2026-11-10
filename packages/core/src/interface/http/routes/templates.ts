/** @module interface/http/routes/templates — session templates for operators: list, create, read and delete (spec 13 §11.1; recording and the T1a host routes are in `template-recording.ts`, the rest arrive with T1b). */

import {
  DeleteTemplateQuery,
  DeleteTemplateResponse,
  TemplateDetailResponse,
  TemplateIdParams,
  TemplateInput,
  TemplateResponse,
  TemplatesPage,
  TemplatesQuery,
} from '@browserhive/contracts/http';
import { defineRoute, reply } from '../define-route.ts';
import { requirePrincipal } from './common.ts';

const tags = ['templates'];

/** Template routes. */
export const TEMPLATE_ROUTES = [
  defineRoute({
    operationId: 'listTemplates',
    tags,
    summary:
      'Every session template with its sites, browser state, live sessions and cap; facets by status, browser state and site health.',
    request: { query: TemplatesQuery },
    responses: { 200: TemplatesPage },
    async handler({ input, services }) {
      return reply(200, await services.templates.list(input.query));
    },
  }),
  defineRoute({
    operationId: 'createTemplate',
    tags,
    summary:
      'Create a template in `recording` with its sites, pinned identity and access rule. Under auth=token `policy.authorized_principals` is required (`[]` = every agent).',
    request: { body: TemplateInput },
    responses: { 201: TemplateResponse },
    errors: ['TEMPLATE_NAME_TAKEN'],
    async handler({ input, principal, services }) {
      const owner = requirePrincipal(principal).subject;
      return reply(201, { template: await services.templates.create(input.body, owner) });
    },
  }),
  defineRoute({
    operationId: 'getTemplate',
    tags,
    summary:
      'One template with its browser, sites, live session count, other windows and the windows shared by several sessions.',
    request: { params: TemplateIdParams },
    responses: { 200: TemplateDetailResponse },
    errors: ['TEMPLATE_NOT_FOUND'],
    async handler({ input, services }) {
      return reply(200, await services.templates.get(input.params.template_id));
    },
  }),
  defineRoute({
    operationId: 'deleteTemplate',
    tags,
    summary:
      'Delete a template: stops its browser and deletes its directory. With live sessions it needs force=true, which closes them. Deleting does not sign out at the sites.',
    request: { params: TemplateIdParams, query: DeleteTemplateQuery },
    responses: { 200: DeleteTemplateResponse },
    errors: ['TEMPLATE_NOT_FOUND', 'TEMPLATE_IN_USE'],
    async handler({ input, principal, services }) {
      return reply(
        200,
        await services.templates.remove(input.params.template_id, {
          force: input.query.force,
          by: requirePrincipal(principal).subject,
        }),
      );
    },
  }),
];
