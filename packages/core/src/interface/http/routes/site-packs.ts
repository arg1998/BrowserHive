/** @module interface/http/routes/site-packs — the Site packs API (spec 13 §11.1, PR T3a): the catalog with the registry's status, one pack, its field-level diff, Apply, Reject, Revert, Pin, Follow, approving a local file, enabling, reloading, importing an unsigned pack, and the change and guard-hit histories. The registry client's check and download arrive with T4b. */

import {
  SITE_PACK_IMPORT_MAX_BYTES,
  SiteGuardHitsPage,
  SiteGuardHitsQuery,
  SitePackApproveLocalRequest,
  SitePackChangesPage,
  SitePackChangesQuery,
  SitePackDetailResponse,
  SitePackDiffQuery,
  SitePackDiffResponse,
  SitePackFollowRequest,
  SitePackIdParams,
  SitePackImportRequest,
  SitePackImportResponse,
  SitePackPinRequest,
  SitePackReloadResponse,
  SitePacksQuery,
  SitePacksResponse,
  SitePackVersionRequest,
  SitePackViewResponse,
} from '@browserhive/contracts/http';
import { packInvalid } from '../../../app/site-packs/registry-errors.ts';
import type { RequestPrincipal } from '../../../domain/auth/principal.ts';
import { defineRoute, reply } from '../define-route.ts';
import { requirePrincipal } from './common.ts';

const tags = ['site-packs'];
const by = (principal: RequestPrincipal | null): string => requirePrincipal(principal).subject;

/** Site-pack routes. */
export const SITE_PACK_ROUTES = [
  defineRoute({
    operationId: 'listSitePacks',
    tags,
    summary:
      "Every site pack (bundled, local files) with its approval, provenance, local file state, pending versions and the templates using it, plus the registry's status and the counts the navigation badge shows.",
    request: { query: SitePacksQuery },
    responses: { 200: SitePacksResponse },
    async handler({ input, services }) {
      return reply(200, services.sitePacks.list(input.query));
    },
  }),
  defineRoute({
    operationId: 'listSitePackChanges',
    tags,
    summary:
      'The history of pack candidates and decisions (approvals, applies, rejects, reverts, local approvals), newest first.',
    request: { query: SitePackChangesQuery },
    responses: { 200: SitePackChangesPage },
    async handler({ input, services }) {
      return reply(200, await services.sitePacks.changes(input.query));
    },
  }),
  defineRoute({
    operationId: 'listSiteGuardHits',
    tags,
    summary:
      'Guard decisions on template sessions (blocks, confirmations, warnings), newest first; filterable by template, session, pack and action.',
    request: { query: SiteGuardHitsQuery },
    responses: { 200: SiteGuardHitsPage },
    async handler({ input, services }) {
      return reply(200, await services.sitePacks.guardHits(input.query));
    },
  }),
  defineRoute({
    operationId: 'reloadSitePacks',
    tags,
    summary:
      'Re-read the bundled packs and the local folder (sitePacksDir); a folder that cannot be read keeps what was loaded before.',
    request: {},
    responses: { 200: SitePackReloadResponse },
    async handler({ principal, services }) {
      return reply(200, { stats: await services.sitePacks.reload(by(principal)) });
    },
  }),
  defineRoute({
    operationId: 'importSitePack',
    tags,
    summary:
      "Import one unsigned pack ({text}: the file's exact text, stored byte for byte; or {pack}: a parsed pack, stored re-serialized): it is validated, stored in the local folder as <id>.json and applies only after approve-local. Signed layouts ({files}) arrive with a later release.",
    request: { body: SitePackImportRequest },
    responses: { 200: SitePackImportResponse },
    errors: ['SITE_PACK_INVALID', 'SITE_PACK_DOMAIN_TAKEN', 'PAYLOAD_TOO_LARGE'],
    bodyLimitBytes: SITE_PACK_IMPORT_MAX_BYTES,
    async handler({ input, principal, services }) {
      const body = input.body;
      if ('files' in body) {
        throw packInvalid('import', [
          { path: 'files', message: 'signed layouts arrive with a later release' },
        ]);
      }
      const imported =
        'text' in body
          ? await services.sitePacks.importPackText(body.text, by(principal))
          : await services.sitePacks.importPack(body.pack, by(principal));
      return reply(200, imported);
    },
  }),
  defineRoute({
    operationId: 'getSitePack',
    tags,
    summary:
      'One pack: its view, the content in force (else the offered or local one) and every version known.',
    request: { params: SitePackIdParams },
    responses: { 200: SitePackDetailResponse },
    errors: ['SITE_PACK_NOT_FOUND'],
    async handler({ input, services }) {
      return reply(200, services.sitePacks.detail(input.params.pack_id));
    },
  }),
  defineRoute({
    operationId: 'diffSitePack',
    tags,
    summary:
      'The field-level diff from the approved version (or `from`) to a pending version or the current local file (`to=local`). Unclassified until a later release.',
    request: { params: SitePackIdParams, query: SitePackDiffQuery },
    responses: { 200: SitePackDiffResponse },
    errors: ['SITE_PACK_NOT_FOUND', 'CONFLICT'],
    async handler({ input, services }) {
      return reply(200, await services.sitePacks.diff(input.params.pack_id, input.query));
    },
  }),
  defineRoute({
    operationId: 'applySitePack',
    tags,
    summary:
      'Apply a pending version: it becomes the approved version for every template using the pack; the previous one is kept for Revert.',
    request: { params: SitePackIdParams, body: SitePackVersionRequest },
    responses: { 200: SitePackViewResponse },
    errors: ['SITE_PACK_NOT_FOUND', 'SITE_PACK_UPDATE_NOT_PENDING', 'SITE_PACK_DOMAIN_TAKEN'],
    async handler({ input, principal, services }) {
      const view = await services.sitePacks.apply(
        input.params.pack_id,
        input.body.version,
        by(principal),
      );
      return reply(200, { view });
    },
  }),
  defineRoute({
    operationId: 'rejectSitePack',
    tags,
    summary: 'Reject a pending version; it is not offered again.',
    request: { params: SitePackIdParams, body: SitePackVersionRequest },
    responses: { 200: SitePackViewResponse },
    errors: ['SITE_PACK_NOT_FOUND', 'SITE_PACK_UPDATE_NOT_PENDING'],
    async handler({ input, principal, services }) {
      const view = await services.sitePacks.reject(
        input.params.pack_id,
        input.body.version,
        by(principal),
      );
      return reply(200, { view });
    },
  }),
  defineRoute({
    operationId: 'revertSitePack',
    tags,
    summary: 'Restore the previous approved version in one action.',
    request: { params: SitePackIdParams },
    responses: { 200: SitePackViewResponse },
    errors: ['SITE_PACK_NOT_FOUND', 'SITE_PACK_NO_PREVIOUS'],
    async handler({ input, principal, services }) {
      return reply(200, {
        view: await services.sitePacks.revert(input.params.pack_id, by(principal)),
      });
    },
  }),
  defineRoute({
    operationId: 'pinSitePack',
    tags,
    summary: 'Pin the approved version (newer ones stay listed), or unpin with null.',
    request: { params: SitePackIdParams, body: SitePackPinRequest },
    responses: { 200: SitePackViewResponse },
    errors: ['SITE_PACK_NOT_FOUND', 'VALIDATION_FAILED'],
    async handler({ input, principal, services }) {
      const view = await services.sitePacks.pin(
        input.params.pack_id,
        input.body.version,
        by(principal),
      );
      return reply(200, { view });
    },
  }),
  defineRoute({
    operationId: 'followSitePack',
    tags,
    summary:
      'Follow updates on, off, or automatically (null: followed while a template uses the pack).',
    request: { params: SitePackIdParams, body: SitePackFollowRequest },
    responses: { 200: SitePackViewResponse },
    errors: ['SITE_PACK_NOT_FOUND'],
    async handler({ input, principal, services }) {
      const view = await services.sitePacks.setFollow(
        input.params.pack_id,
        input.body.follow,
        by(principal),
      );
      return reply(200, { view });
    },
  }),
  defineRoute({
    operationId: 'approveLocalSitePack',
    tags,
    summary:
      "Approve the local file's current content by the SHA-256 reviewed; a file that changed since it was shown is 409. Later edits apply only after another approval.",
    request: { params: SitePackIdParams, body: SitePackApproveLocalRequest },
    responses: { 200: SitePackViewResponse },
    errors: [
      'SITE_PACK_NOT_FOUND',
      'SITE_PACK_NO_LOCAL_FILE',
      'SITE_PACK_INVALID',
      'SITE_PACK_DOMAIN_TAKEN',
      'CONFLICT',
    ],
    async handler({ input, principal, services }) {
      const view = await services.sitePacks.approveLocal(
        input.params.pack_id,
        input.body.sha256,
        by(principal),
      );
      return reply(200, { view });
    },
  }),
  defineRoute({
    operationId: 'enableSitePack',
    tags,
    summary: 'Enable a pack: its approved version applies again.',
    request: { params: SitePackIdParams },
    responses: { 200: SitePackViewResponse },
    errors: ['SITE_PACK_NOT_FOUND'],
    async handler({ input, principal, services }) {
      return reply(200, {
        view: await services.sitePacks.setEnabled(input.params.pack_id, true, by(principal)),
      });
    },
  }),
  defineRoute({
    operationId: 'disableSitePack',
    tags,
    summary: 'Disable a pack: its sites behave as generic sites; the approval is kept.',
    request: { params: SitePackIdParams },
    responses: { 200: SitePackViewResponse },
    errors: ['SITE_PACK_NOT_FOUND'],
    async handler({ input, principal, services }) {
      return reply(200, {
        view: await services.sitePacks.setEnabled(input.params.pack_id, false, by(principal)),
      });
    },
  }),
];
