/** @module lib/api/operations-site-packs — the site-pack operations of `HTTP_ENDPOINTS` (spec 13 §11.1 "Site packs", PRs T3a, T3b and the registry client of T4b: check, download, download all, export) and a template site's **Clear stop**, spread into `OPERATIONS` */
import {
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
  TemplateSiteParams,
  TemplateSiteResponse,
} from '@browserhive/contracts/http';

/** `POST /site-packs/import` body: `{text}` (the file's exact UTF-8 text, hashed and stored verbatim), `{pack}` or `{files}`. */
export const SitePackImportBody = SitePackImportRequest;

/** Site-pack routes (T3a, T3b; the registry client's check, downloads and export from T4b). */
export const SITE_PACK_OPERATIONS = {
  listSitePacks: { query: SitePacksQuery, response: SitePacksResponse },
  listSitePackChanges: { query: SitePackChangesQuery, response: SitePackChangesPage },
  listSiteGuardHits: { query: SiteGuardHitsQuery, response: SiteGuardHitsPage },
  listSiteStrategies: { response: SiteStrategiesResponse },
  reloadSitePacks: { response: SitePackReloadResponse },
  checkSitePacks: { response: SitePackCheckResponse },
  downloadAllSitePacks: { response: SitePackDownloadAllResponse },
  exportSitePacks: { response: SitePackExportResponse },
  downloadSitePack: {
    params: SitePackIdParams,
    body: SitePackDownloadRequest,
    response: SitePackDownloadResponse,
  },
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
