/** @module interface/http/routes/site-packs — the Site packs API (spec 13 §11.1, PRs T3a, T3b and T4b): the catalog with the registry's status, the strategy set, one pack, its classified field-level diff, Apply, Reject, Revert, Pin, Follow, approving a local file, enabling, reloading, importing an unsigned pack or a signed layout, the change and guard-hit histories, and the registry client's Check now, Download & review, Download all and export. */

import {
  SITE_PACK_IMPORT_MAX_BYTES,
  SiteGuardHitsPage,
  SiteGuardHitsQuery,
  SitePackApproveLocalRequest,
  SitePackChangesPage,
  SitePackChangesQuery,
  SitePackCheckResponse,
  SitePackDetailResponse,
  SitePackDiffQuery,
  SitePackDiffResponse,
  SitePackDownloadAllResponse,
  SitePackDownloadRequest,
  SitePackDownloadResponse,
  SitePackExportResponse,
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
  SiteStrategiesResponse,
} from '@browserhive/contracts/http';
import { packInvalid, registryUnavailable } from '../../../app/site-packs/registry-errors.ts';
import { strategyViews } from '../../../app/site-packs/strategy-views.ts';
import type { RequestPrincipal } from '../../../domain/auth/principal.ts';
import { defineRoute, reply } from '../define-route.ts';
import type { SitePackClientPort } from '../services.ts';
import { requirePrincipal } from './common.ts';

const tags = ['site-packs'];
const by = (principal: RequestPrincipal | null): string => requirePrincipal(principal).subject;

/** The registry client, or `SITE_PACKS_REGISTRY_UNAVAILABLE` (`packs_off`) when the server has none. */
function clientOf(services: { readonly sitePackClient?: SitePackClientPort }): SitePackClientPort {
  if (services.sitePackClient === undefined) throw registryUnavailable('packs_off');
  return services.sitePackClient;
}

const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/;

/** A signed layout's files, decoded exactly; a path outside the layout or a bad encoding is refused. */
function layoutFilesOf(files: Readonly<Record<string, string>>): Map<string, Uint8Array> {
  const out = new Map<string, Uint8Array>();
  const issues: { path: string; message: string }[] = [];
  for (const [path, text] of Object.entries(files)) {
    const allowed =
      /^(?:keys|index)\.json(?:\.sig)?$/.test(path) ||
      /^packs\/[a-z0-9.-]+\/[0-9a-f]{64}\.json$/.test(path);
    if (!allowed) {
      issues.push({ path, message: 'not a file of a signed layout' });
      continue;
    }
    if (text.length % 4 !== 0 || !BASE64_RE.test(text)) {
      issues.push({ path, message: 'not base64' });
      continue;
    }
    out.set(path, new Uint8Array(Buffer.from(text, 'base64')));
  }
  if (issues.length > 0) throw packInvalid('import', issues);
  return out;
}

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
    operationId: 'listSiteStrategies',
    tags,
    summary:
      'The strategies this binary implements (spec 13 §9.4): title, description, kind, hook points, and each parameter with its default, bounds and safe direction, for describing what a pack selects.',
    request: {},
    responses: { 200: SiteStrategiesResponse },
    async handler() {
      return reply(200, strategyViews());
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
    operationId: 'checkSitePacks',
    tags,
    summary:
      "Check for updates now: fetch the registry's signed index only (keys.json, index.json and their signatures; no cookie, query, version or install identifier), verify it with the pinned keys and the stored rollback floors, and list newer versions as available. Nothing is downloaded or applied. 'disabled' when the update check is off or this build pins no registry keys; a failed fetch or a refused file is 'failed' with the reason and changes nothing.",
    request: {},
    responses: { 200: SitePackCheckResponse },
    rateLimit: { limit: 6, windowMs: 60_000, key: 'principal' },
    async handler({ principal, services }) {
      return reply(200, await clientOf(services).check(by(principal)));
    },
  }),
  defineRoute({
    operationId: 'downloadAllSitePacks',
    tags,
    summary:
      'Download all: fetch every version the verified index lists that BrowserHive lacks, of every pack, so the registry cannot tell which pack you care about. Each file is verified against the index (size, SHA-256, schema, client range); pending versions become downloaded and classified. Nothing is applied.',
    request: {},
    responses: { 200: SitePackDownloadAllResponse },
    errors: ['SITE_PACKS_REGISTRY_UNAVAILABLE'],
    async handler({ principal, services }) {
      return reply(200, await clientOf(services).downloadAll(by(principal)));
    },
  }),
  defineRoute({
    operationId: 'exportSitePacks',
    tags,
    summary:
      'The signed layout BrowserHive holds (keys.json, index.json, their signatures and every verified pack file it holds, base64 by path), for `sitepacks export` and air-gapped hosts.',
    request: {},
    responses: { 200: SitePackExportResponse },
    errors: ['SITE_PACKS_REGISTRY_UNAVAILABLE'],
    async handler({ services }) {
      return reply(200, await clientOf(services).exportLayout());
    },
  }),
  defineRoute({
    operationId: 'importSitePack',
    tags,
    summary:
      "Import one unsigned pack ({text}: the file's exact text, stored byte for byte; or {pack}: a parsed pack, stored re-serialized): it is validated, stored in the local folder as <id>.json and applies only after approve-local. Or a signed layout ({files}: keys.json, index.json, their signatures and packs/<id>/<sha256>.json, base64 by path): verified with the pinned keys exactly as an update check is, and its versions are queued for approval.",
    request: { body: SitePackImportRequest },
    responses: { 200: SitePackImportResponse },
    errors: [
      'SITE_PACK_INVALID',
      'SITE_PACK_DOMAIN_TAKEN',
      'SITE_PACKS_REGISTRY_UNAVAILABLE',
      'PAYLOAD_TOO_LARGE',
    ],
    bodyLimitBytes: SITE_PACK_IMPORT_MAX_BYTES,
    async handler({ input, principal, services }) {
      const body = input.body;
      if ('files' in body) {
        const files = layoutFilesOf(body.files);
        return reply(
          200,
          await clientOf(services).importLayout(
            files,
            body.name ?? 'imported layout',
            by(principal),
          ),
        );
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
      "The field-level diff from the approved version (or `from`) to a pending version, the previous approved version (what Revert restores) or the current local file (`to=local`), classified (spec 13 §9.7): each change's class and the candidate's (the strongest; `new_pack` without an approved version), with the templates' current settings.",
    request: { params: SitePackIdParams, query: SitePackDiffQuery },
    responses: { 200: SitePackDiffResponse },
    errors: ['SITE_PACK_NOT_FOUND', 'CONFLICT'],
    async handler({ input, services }) {
      return reply(200, await services.sitePacks.diff(input.params.pack_id, input.query));
    },
  }),
  defineRoute({
    operationId: 'downloadSitePack',
    tags,
    summary:
      'Download & review: fetch exactly the version the verified index lists as available for this pack (which tells the registry this version was downloaded; Download all does not), verify its size, SHA-256, schema and client range, and classify it against the approved version. Returns the classified field-level diff; nothing is applied.',
    request: { params: SitePackIdParams, body: SitePackDownloadRequest },
    responses: { 200: SitePackDownloadResponse },
    errors: [
      'SITE_PACK_NOT_FOUND',
      'SITE_PACK_NOT_LISTED',
      'SITE_PACKS_REGISTRY_UNAVAILABLE',
      'SITE_PACK_DOWNLOAD_FAILED',
    ],
    async handler({ input, principal, services }) {
      return reply(
        200,
        await clientOf(services).download(input.params.pack_id, input.body.version, by(principal)),
      );
    },
  }),
  defineRoute({
    operationId: 'applySitePack',
    tags,
    summary:
      "Apply a pending version: it becomes the approved version for every template using the pack; the previous one is kept for Revert. Refused (SITE_PACK_BELOW_FLOOR) while a template using the pack is below the version's stealth floor.",
    request: { params: SitePackIdParams, body: SitePackVersionRequest },
    responses: { 200: SitePackViewResponse },
    errors: [
      'SITE_PACK_NOT_FOUND',
      'SITE_PACK_UPDATE_NOT_PENDING',
      'SITE_PACK_DOMAIN_TAKEN',
      'SITE_PACK_BELOW_FLOOR',
    ],
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
    summary:
      "Restore the previous approved version in one action. Refused (SITE_PACK_BELOW_FLOOR) while a template using the pack is below that version's stealth floor.",
    request: { params: SitePackIdParams },
    responses: { 200: SitePackViewResponse },
    errors: ['SITE_PACK_NOT_FOUND', 'SITE_PACK_NO_PREVIOUS', 'SITE_PACK_BELOW_FLOOR'],
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
      'SITE_PACK_BELOW_FLOOR',
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
