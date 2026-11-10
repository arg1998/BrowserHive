/** @module interface/http/routes/template-ops — the T1b template routes (spec 13 §11.1): edit, disable and enable, sites, the browser (start, stop, restart, parked pages), versions, restore and seed operations, the access tester and the data-directory reveal. */

import {
  PatchTemplateVersionRequest,
  PutTemplateSiteRequest,
  ResolveTemplateAccessRequest,
  ResolveTemplateAccessResponse,
  RestoreTemplateVersionRequest,
  RevealDataDirResponse,
  SaveTemplateVersionResponse,
  SeedTemplateQuery,
  TEMPLATE_SEED_MAX_BYTES,
  TemplateChangeResponse,
  TemplateHostResponse,
  TemplateIdParams,
  TemplateIfMatchHeaders,
  TemplateOkResponse,
  TemplateOperation,
  TemplateOperationAccepted,
  TemplateOperationParams,
  TemplatePageParams,
  TemplatePatchInput,
  TemplateSiteParams,
  TemplateSiteResponse,
  TemplateStorageState,
  TemplateVersionParams,
  TemplateVersionResponse,
  TemplateVersionsPage,
  TemplateVersionsQuery,
} from '@browserhive/contracts/http';
import { versionNotFound } from '../../../app/templates/template-state.ts';
import type { RequestPrincipal } from '../../../domain/auth/principal.ts';
import { defineRoute, reply } from '../define-route.ts';
import { requirePrincipal } from './common.ts';

const tags = ['templates'];
/** Seeding starts a browser on the BrowserHive machine (spec 13 §11.1: 6/min). */
const SEED_RATE = { limit: 6, windowMs: 60_000, key: 'principal' } as const;
/** The seed body: the storage state plus JSON overhead (spec 13 §7.4: ≤ 16 MiB). */
const SEED_BODY_BYTES = TEMPLATE_SEED_MAX_BYTES + 64 * 1024;

const by = (principal: RequestPrincipal | null): string => requirePrincipal(principal).subject;

const hostRoute = (operationId: string, action: 'start' | 'stop' | 'restart', summary: string) =>
  defineRoute({
    operationId,
    tags,
    summary,
    request: { params: TemplateIdParams },
    responses: { 200: TemplateHostResponse },
    errors: ['TEMPLATE_NOT_FOUND', 'TEMPLATE_DISABLED'],
    async handler({ input, principal, services }) {
      const host = await services.templateActions.host(
        input.params.template_id,
        action,
        by(principal),
      );
      return reply(200, { host });
    },
  });

/** T1b template routes. */
export const TEMPLATE_OPS_ROUTES = [
  defineRoute({
    operationId: 'getTemplateOperation',
    tags,
    summary: 'A restore or seed operation: running, done (with the version written) or failed.',
    request: { params: TemplateOperationParams },
    responses: { 200: TemplateOperation },
    async handler({ input, services }) {
      return reply(200, services.templateOperations.get(input.params.operation_id));
    },
  }),
  defineRoute({
    operationId: 'updateTemplate',
    tags,
    summary:
      'Edit a template (not its pinned identity). proxy and channel restart the browser and need confirm_identity_change. Access and sealing changes apply to live sessions at once; sessions that lost access are closed and listed.',
    request: {
      params: TemplateIdParams,
      body: TemplatePatchInput,
      headers: TemplateIfMatchHeaders,
    },
    responses: { 200: TemplateChangeResponse },
    errors: ['TEMPLATE_NOT_FOUND', 'TEMPLATE_NAME_TAKEN', 'CONFLICT'],
    async handler({ input, principal, services }) {
      return reply(
        200,
        await services.templateEdit.update(input.params.template_id, input.body, {
          ifMatch: input.headers['if-match'],
          by: by(principal),
        }),
      );
    },
  }),
  defineRoute({
    operationId: 'disableTemplate',
    tags,
    summary: 'Disable a template: agents can no longer launch it and its live sessions close.',
    request: { params: TemplateIdParams },
    responses: { 200: TemplateChangeResponse },
    errors: ['TEMPLATE_NOT_FOUND'],
    async handler({ input, principal, services }) {
      return reply(
        200,
        await services.templateEdit.setEnabled(input.params.template_id, false, by(principal)),
      );
    },
  }),
  defineRoute({
    operationId: 'enableTemplate',
    tags,
    summary: 'Enable a disabled template again.',
    request: { params: TemplateIdParams },
    responses: { 200: TemplateChangeResponse },
    errors: ['TEMPLATE_NOT_FOUND'],
    async handler({ input, principal, services }) {
      return reply(
        200,
        await services.templateEdit.setEnabled(input.params.template_id, true, by(principal)),
      );
    },
  }),
  defineRoute({
    operationId: 'putTemplateSite',
    tags,
    summary: 'Add a site (at most 16) or change its enabled flag and write policy.',
    request: { params: TemplateSiteParams, body: PutTemplateSiteRequest },
    responses: { 200: TemplateSiteResponse },
    errors: ['TEMPLATE_NOT_FOUND'],
    async handler({ input, principal, services }) {
      const site = await services.templateEdit.putSite(
        input.params.template_id,
        input.params.site_id,
        input.body,
        by(principal),
      );
      return reply(200, { site });
    },
  }),
  defineRoute({
    operationId: 'deleteTemplateSite',
    tags,
    summary: "Remove a site (not the last one). Its sign-in stays in the template's browser.",
    request: { params: TemplateSiteParams },
    responses: { 200: TemplateOkResponse },
    errors: ['TEMPLATE_NOT_FOUND', 'CONFLICT'],
    async handler({ input, principal, services }) {
      await services.templateEdit.removeSite(
        input.params.template_id,
        input.params.site_id,
        by(principal),
      );
      return reply(200, { ok: true as const });
    },
  }),
  defineRoute({
    operationId: 'seedTemplate',
    tags,
    summary:
      'Seed the sign-ins from a Playwright storage state (the body, ≤ 16 MiB, never stored in plain text): the browser restarts, the state is applied and an import version is written; the template becomes ready. Over a ready template it needs confirm=true.',
    request: { params: TemplateIdParams, query: SeedTemplateQuery, body: TemplateStorageState },
    responses: { 202: TemplateOperationAccepted },
    errors: ['TEMPLATE_NOT_FOUND', 'TEMPLATE_DISABLED', 'CONFLICT'],
    bodyLimitBytes: SEED_BODY_BYTES,
    rateLimit: SEED_RATE,
    async handler({ input, principal, services }) {
      return reply(
        202,
        await services.templateOperations.seed(input.params.template_id, input.body, {
          confirm: input.query.confirm,
          by: by(principal),
        }),
      );
    },
  }),
  hostRoute('startTemplateHost', 'start', "Start the template's browser."),
  hostRoute(
    'stopTemplateHost',
    'stop',
    "Stop the template's browser after a final checkpoint; its sessions close.",
  ),
  hostRoute(
    'restartTemplateHost',
    'restart',
    "Restart the template's browser (clears a failed browser): sessions get templateDrainTimeout to finish.",
  ),
  defineRoute({
    operationId: 'closeTemplatePage',
    tags,
    summary: 'Close a page of the browser that no session owns (Other windows).',
    request: { params: TemplatePageParams },
    responses: { 200: TemplateOkResponse },
    errors: ['TEMPLATE_NOT_FOUND'],
    async handler({ input, principal, services }) {
      await services.templateActions.closePage(
        input.params.template_id,
        input.params.target_id,
        by(principal),
      );
      return reply(200, { ok: true as const });
    },
  }),
  defineRoute({
    operationId: 'listTemplateVersions',
    tags,
    summary:
      'The versions (newest first, with summary, health, Last good and readability) and the rolling checkpoint.',
    request: { params: TemplateIdParams, query: TemplateVersionsQuery },
    responses: { 200: TemplateVersionsPage },
    errors: ['TEMPLATE_NOT_FOUND'],
    async handler({ input, services }) {
      return reply(
        200,
        await services.templateVersions.list(input.params.template_id, input.query),
      );
    },
  }),
  defineRoute({
    operationId: 'saveTemplateVersion',
    tags,
    summary:
      'Save version now: a manual version from the running browser; version null when nothing changed since the newest one.',
    request: { params: TemplateIdParams },
    responses: { 200: SaveTemplateVersionResponse },
    errors: ['TEMPLATE_NOT_FOUND', 'CONFLICT', 'TEMPLATE_VERSION_UNREADABLE'],
    async handler({ input, principal, services }) {
      const version = await services.templateActions.saveVersion(
        input.params.template_id,
        by(principal),
      );
      return reply(200, { version });
    },
  }),
  defineRoute({
    operationId: 'restoreTemplateVersion',
    tags,
    summary:
      'Restore a version (or latest, the rolling checkpoint) as an operation: sessions close at once with force_close, else they get templateDrainTimeout; the browser restarts with the version applied and a restore version is written.',
    request: { params: TemplateVersionParams, body: RestoreTemplateVersionRequest },
    responses: { 202: TemplateOperationAccepted },
    errors: [
      'TEMPLATE_NOT_FOUND',
      'TEMPLATE_VERSION_NOT_FOUND',
      'TEMPLATE_VERSION_UNREADABLE',
      'CONFLICT',
    ],
    async handler({ input, principal, services }) {
      return reply(
        202,
        await services.templateOperations.restore(input.params.template_id, input.params.version, {
          forceClose: input.body.force_close === true,
          by: by(principal),
        }),
      );
    },
  }),
  defineRoute({
    operationId: 'updateTemplateVersion',
    tags,
    summary: 'Pin a version (kept past templateVersionsKeep) or unpin it.',
    request: { params: TemplateVersionParams, body: PatchTemplateVersionRequest },
    responses: { 200: TemplateVersionResponse },
    errors: ['TEMPLATE_NOT_FOUND', 'TEMPLATE_VERSION_NOT_FOUND'],
    async handler({ input, principal, services }) {
      const { template_id: id, version } = input.params;
      if (version === 'latest') throw versionNotFound(id, version);
      const row = await services.templateActions.pin(id, version, input.body.pinned, by(principal));
      return reply(200, { version: row });
    },
  }),
  defineRoute({
    operationId: 'resolveTemplateAccess',
    tags,
    summary:
      "Test the template's access rule for a principal and harness (D-48); agents never see the reason.",
    request: { params: TemplateIdParams, body: ResolveTemplateAccessRequest },
    responses: { 200: ResolveTemplateAccessResponse },
    errors: ['TEMPLATE_NOT_FOUND'],
    async handler({ input, services }) {
      return reply(
        200,
        await services.templateEdit.resolveAccess(input.params.template_id, input.body),
      );
    },
  }),
  defineRoute({
    operationId: 'revealTemplateDataDir',
    tags,
    summary: "Open the template's data directory in the host file manager (honest result).",
    request: { params: TemplateIdParams },
    responses: { 200: RevealDataDirResponse },
    errors: ['TEMPLATE_NOT_FOUND'],
    async handler({ input, principal, services }) {
      const dir = await services.templateActions.dataDir(input.params.template_id, by(principal));
      const result = await services.desktop.reveal(dir);
      return reply(200, {
        path: result.path,
        exists: result.exists,
        desktop: result.desktop,
        opened: result.opened,
        ...(result.reason !== undefined && { reason: result.reason }),
        ...(result.detail !== undefined && { detail: result.detail }),
      });
    },
  }),
];
