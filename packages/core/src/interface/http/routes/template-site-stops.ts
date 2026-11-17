/** @module interface/http/routes/template-site-stops — **Clear stop** (spec 13 §9.5, §11.1, PR T3a): a site a `stop` challenge stopped is usable by agents again; audited as `template.site.clear_stop`. */

import { TemplateSiteParams, TemplateSiteResponse } from '@browserhive/contracts/http';
import { defineRoute, reply } from '../define-route.ts';
import { requirePrincipal } from './common.ts';

const tags = ['templates'];

/** The stop routes. */
export const TEMPLATE_SITE_STOP_ROUTES = [
  defineRoute({
    operationId: 'clearTemplateSiteStop',
    tags,
    summary:
      'Clear stop: agents may navigate to and act on a site a terminal security check stopped (a no-op when the site is not stopped).',
    request: { params: TemplateSiteParams },
    responses: { 200: TemplateSiteResponse },
    errors: ['TEMPLATE_NOT_FOUND'],
    async handler({ input, principal, services }) {
      const site = await services.templateSiteStops.clear(
        input.params.template_id,
        input.params.site_id,
        requirePrincipal(principal).subject,
      );
      return reply(200, { site });
    },
  }),
] as const;
