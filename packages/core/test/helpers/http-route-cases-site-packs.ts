/** @module test/helpers/http-route-cases-site-packs — the route cases of the T3a site-pack routes (spec 13 §11.1): the kit's in-memory registry ships `site-a.test` v1; setups approve it, put a newer bundled version or a local file, and reload. */

import type { CaseContext, RouteCase } from './http-route-case-types.ts';
import { packSha, sitePack } from './site-pack-kit.ts';

const api = (path: string) => `/api/v1${path}`;
const pack = (path = '') => api(`/site-packs/site-a.test${path}`);

/** Approves `site-a.test` v1 as an operator adding the site would. */
async function approved(ctx: CaseContext): Promise<void> {
  await ctx.kit.sitePacks.registry.approveSite('site-a.test', undefined, 'admin');
}

/** v1 approved, v2 bundled by a "newer release" and pending. */
async function pending(ctx: CaseContext): Promise<void> {
  await approved(ctx);
  ctx.kit.sitePacks.bundled.put(sitePack('site-a.test', 2, { title: 'Site A v2' }));
  await ctx.kit.sitePacks.registry.reload();
}

/** v2 applied over v1 (Revert has a previous version). */
async function applied(ctx: CaseContext): Promise<void> {
  await pending(ctx);
  await ctx.kit.sitePacks.registry.apply('site-a.test', 2, 'admin');
}

/** The local file the approve-local case reviews. */
const LOCAL = sitePack('site-a.test', 9, { title: 'Local A' });

/** A local file for `site-a.test`, not yet approved. */
async function localFile(ctx: CaseContext): Promise<void> {
  ctx.kit.sitePacks.local.put(LOCAL);
  await ctx.kit.sitePacks.registry.reload();
}

/** The site-pack routes. */
export const SITE_PACK_CASES: readonly RouteCase[] = [
  {
    operationId: 'listSitePacks',
    success: { path: api('/site-packs?source=bundled,local&pending=false'), status: 200 },
    invalid: { path: api('/site-packs?source=floppy') },
  },
  {
    operationId: 'listSitePackChanges',
    setup: approved,
    success: { path: api('/site-packs/changes?decision=approved'), status: 200 },
    invalid: { path: api('/site-packs/changes?decision=maybe') },
  },
  {
    operationId: 'listSiteGuardHits',
    success: { path: api('/site-packs/guard-hits?action=block'), status: 200 },
    invalid: { path: api('/site-packs/guard-hits?action=explode') },
  },
  {
    operationId: 'reloadSitePacks',
    success: { method: 'POST', path: api('/site-packs/reload'), status: 200 },
    invalid: null,
  },
  {
    operationId: 'importSitePack',
    success: {
      method: 'POST',
      path: api('/site-packs/import'),
      body: { pack: sitePack('site-b.test', 1) },
      status: 200,
    },
    invalid: { method: 'POST', path: api('/site-packs/import'), body: { other: true } },
  },
  {
    operationId: 'getSitePack',
    success: { path: pack(), status: 200 },
    invalid: { path: api(`/site-packs/${'x'.repeat(300)}`) },
  },
  {
    operationId: 'diffSitePack',
    setup: pending,
    success: { path: pack('/diff?to=2'), status: 200 },
    invalid: { path: pack('/diff?to=zero') },
  },
  {
    operationId: 'applySitePack',
    setup: pending,
    success: { method: 'POST', path: pack('/apply'), body: { version: 2 }, status: 200 },
    invalid: { method: 'POST', path: pack('/apply'), body: { version: 'two' } },
  },
  {
    operationId: 'rejectSitePack',
    setup: pending,
    success: { method: 'POST', path: pack('/reject'), body: { version: 2 }, status: 200 },
    invalid: { method: 'POST', path: pack('/reject'), body: {} },
  },
  {
    operationId: 'revertSitePack',
    setup: applied,
    success: { method: 'POST', path: pack('/revert'), status: 200 },
    invalid: { method: 'POST', path: api(`/site-packs/${'x'.repeat(300)}/revert`) },
  },
  {
    operationId: 'pinSitePack',
    setup: approved,
    success: { method: 'PUT', path: pack('/pin'), body: { version: 1 }, status: 200 },
    invalid: { method: 'PUT', path: pack('/pin'), body: { version: 0 } },
  },
  {
    operationId: 'followSitePack',
    success: { method: 'PUT', path: pack('/follow'), body: { follow: true }, status: 200 },
    invalid: { method: 'PUT', path: pack('/follow'), body: { follow: 'yes' } },
  },
  {
    operationId: 'approveLocalSitePack',
    setup: localFile,
    success: {
      method: 'POST',
      path: pack('/approve-local'),
      body: { sha256: packSha(LOCAL) },
      status: 200,
    },
    invalid: { method: 'POST', path: pack('/approve-local'), body: { sha256: 'short' } },
  },
  {
    operationId: 'enableSitePack',
    success: { method: 'POST', path: pack('/enable'), status: 200 },
    invalid: { method: 'POST', path: api(`/site-packs/${'x'.repeat(300)}/enable`) },
  },
  {
    operationId: 'disableSitePack',
    success: { method: 'POST', path: pack('/disable'), status: 200 },
    invalid: { method: 'POST', path: api(`/site-packs/${'x'.repeat(300)}/disable`) },
  },
];
