/** @module test/helpers/http-route-case-types — the shapes of the `/api/v1` route cases and the template setup shared by the case files (spec 09 §3.2). */

import type { HttpKit } from './http-kit.ts';

const api = (path: string) => `/api/v1${path}`;

/** Context handed to dynamic paths and setup hooks. */
export interface CaseContext {
  readonly kit: HttpKit;
  readonly cookie: string;
  /** Values produced by `setup`. */
  readonly state: Record<string, string>;
}

/** One request of a case. */
export interface CaseRequest {
  readonly method?: string;
  readonly path: string | ((ctx: CaseContext) => string);
  readonly body?: unknown;
  readonly headers?: Record<string, string>;
  /** Send without the session cookie. */
  readonly anonymous?: boolean;
}

/** The cases of one operation. */
export interface RouteCase {
  readonly operationId: string;
  readonly success: CaseRequest & { readonly status: number };
  /** `null` when the route declares no request schema (nothing can fail validation). */
  readonly invalid: CaseRequest | null;
  readonly setup?: (ctx: CaseContext) => Promise<void>;
}

/** A valid `POST /templates` body (auth=token needs an explicit access choice, spec 13 §6.1). */
export const TEMPLATE_BODY = {
  name: 'job-hunt',
  sites: [{ site_id: 'www.site-a.test' }],
  policy: { authorized_principals: [] },
};

export async function template(ctx: CaseContext): Promise<void> {
  const response = await ctx.kit.request('POST', api('/templates'), {
    cookie: ctx.cookie,
    body: TEMPLATE_BODY,
  });
  // Under a pending password change the create is refused: a well-formed id keeps the path valid.
  const body = (await response.json()) as { template?: { template_id: string } };
  ctx.state['template'] = body.template?.template_id ?? 'tp-placehold0';
}
