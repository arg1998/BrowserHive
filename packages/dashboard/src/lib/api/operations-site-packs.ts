/** @module lib/api/operations-site-packs — the site-pack operations of `HTTP_ENDPOINTS` (spec 13 §11.1 "Site packs", PR T3a) and a template site's **Clear stop**, spread into `OPERATIONS` */
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
  TemplateSiteParams,
  TemplateSiteResponse,
} from '@browserhive/contracts/http';
import { z } from 'zod';

/**
 * `POST /site-packs/import` body, with the `{text}` form (the file's exact UTF-8 text, hashed and
 * stored verbatim; review S-M3/S-L2). Mirrors the contract once WP-C's branch adds it there; until
 * then the dashboard declares the union itself.
 */
export const SitePackImportBody = z.union([
  ...SitePackImportRequest.options,
  z.strictObject({ text: z.string().min(1).max(SITE_PACK_IMPORT_MAX_BYTES) }),
]);

/** Site-pack routes (T3a; the registry's check and download arrive with T4b). */
export const SITE_PACK_OPERATIONS = {
  listSitePacks: { query: SitePacksQuery, response: SitePacksResponse },
  listSitePackChanges: { query: SitePackChangesQuery, response: SitePackChangesPage },
  listSiteGuardHits: { query: SiteGuardHitsQuery, response: SiteGuardHitsPage },
  reloadSitePacks: { response: SitePackReloadResponse },
  importSitePack: { body: SitePackImportBody, response: SitePackImportResponse },
  getSitePack: { params: SitePackIdParams, response: SitePackDetailResponse },
  diffSitePack: {
    params: SitePackIdParams,
    query: SitePackDiffQuery,
    response: SitePackDiffResponse,
  },
  applySitePack: {
    params: SitePackIdParams,
    body: SitePackVersionRequest,
    response: SitePackViewResponse,
  },
  rejectSitePack: {
    params: SitePackIdParams,
    body: SitePackVersionRequest,
    response: SitePackViewResponse,
  },
  revertSitePack: { params: SitePackIdParams, response: SitePackViewResponse },
  pinSitePack: {
    params: SitePackIdParams,
    body: SitePackPinRequest,
    response: SitePackViewResponse,
  },
  followSitePack: {
    params: SitePackIdParams,
    body: SitePackFollowRequest,
    response: SitePackViewResponse,
  },
  approveLocalSitePack: {
    params: SitePackIdParams,
    body: SitePackApproveLocalRequest,
    response: SitePackViewResponse,
  },
  enableSitePack: { params: SitePackIdParams, response: SitePackViewResponse },
  disableSitePack: { params: SitePackIdParams, response: SitePackViewResponse },
  clearTemplateSiteStop: { params: TemplateSiteParams, response: TemplateSiteResponse },
} as const;
