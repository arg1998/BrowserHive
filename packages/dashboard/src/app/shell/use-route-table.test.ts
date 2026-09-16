/** @module app/shell/use-route-table.test — breadcrumbs follow the URL hierarchy without an app-root crumb; only object pages get a trail */

import { describe, expect, it } from 'bun:test';
import { type CrumbRoute, deriveCrumbs, isObjectPage, routePathOf } from './use-route-table.ts';

const ROOT = { title: 'BrowserHive' };

/** Mirrors the shape of `routeTree.gen.ts`: layouts and the index all sit on `/`. */
const ROUTES: readonly CrumbRoute[] = [
  { fullPath: '/', staticData: ROOT },
  { fullPath: '/', staticData: ROOT },
  { fullPath: '/', staticData: ROOT },
  { fullPath: '/overview', staticData: { title: 'Overview' } },
  { fullPath: '/sessions', staticData: { title: 'Sessions' } },
  {
    fullPath: '/sessions/$id',
    staticData: { title: 'Session', crumb: (params) => (params['id'] ?? '').split('-')[0] ?? '' },
  },
  { fullPath: '/sessions/$id/live', staticData: { title: 'Live view' } },
  { fullPath: '/vault', staticData: { title: 'Vault' } },
  { fullPath: '/vault/log', staticData: { title: 'Vault log' } },
];

describe('deriveCrumbs', () => {
  it('has no root crumb and no trail on a top-level page', () => {
    const crumbs = deriveCrumbs('/overview', {}, ROUTES);
    expect(crumbs).toEqual([{ label: 'Overview', to: '/overview' }]);
    expect(isObjectPage(crumbs)).toBe(false);
  });

  it('walks every ancestor of an un-nested object route', () => {
    const crumbs = deriveCrumbs('/sessions/$id/live', { id: 'demo-sbgn4xs1' }, ROUTES);
    expect(crumbs.map((c) => c.label)).toEqual(['Sessions', 'demo', 'Live view']);
    expect(crumbs.map((c) => c.to)).toEqual([
      '/sessions',
      '/sessions/demo-sbgn4xs1',
      '/sessions/demo-sbgn4xs1/live',
    ]);
    expect(isObjectPage(crumbs)).toBe(true);
  });

  it('handles static nested paths and the root itself', () => {
    const vaultLog = deriveCrumbs('/vault/log', {}, ROUTES);
    expect(vaultLog.map((c) => c.label)).toEqual(['Vault', 'Vault log']);
    expect(isObjectPage(vaultLog, true)).toBe(false);
    expect(deriveCrumbs('/', {}, ROUTES)).toEqual([]);
  });

  it('never repeats a label from layout routes', () => {
    const labels = deriveCrumbs('/sessions', {}, ROUTES).map((c) => c.label);
    expect(new Set(labels).size).toBe(labels.length);
  });

  it('strips layout segments from generated ids', () => {
    expect(routePathOf('/_auth/sessions/$id')).toBe('/sessions/$id');
    expect(routePathOf('')).toBe('/');
  });
});
