/** @module app/shell/use-route-table — derive nav items, breadcrumbs, document title and palette pages from route `staticData` */
import { useMatches, useRouter } from '@tanstack/react-router';
import { useMemo } from 'react';
import type { NavGroup, RouteStaticData } from '@/app/router.tsx';

/** A sidebar / palette item derived from a route. */
export interface NavItem {
  readonly id: string;
  readonly to: string;
  readonly label: string;
  readonly icon: RouteStaticData['nav'] extends infer N
    ? N extends { icon: infer I }
      ? I
      : never
    : never;
  readonly group: NavGroup;
  readonly order: number;
  readonly requires: RouteStaticData['requires'] | undefined;
  readonly keywords: readonly string[];
  readonly key: string | undefined;
}

function hasNav(
  data: RouteStaticData,
): data is RouteStaticData & { nav: NonNullable<RouteStaticData['nav']> } {
  return data.nav !== undefined;
}

/** Strip layout segments (`/_auth/overview` → `/overview`). */
export function routePathOf(fullPath: string): string {
  const cleaned = fullPath
    .split('/')
    .filter((segment) => segment.length > 0 && !segment.startsWith('_'))
    .join('/');
  return `/${cleaned}`.replace(/\/$/, '') || '/';
}

/** Every navigable route with `staticData.nav`, sorted by group then order. */
export function useNavItems(): readonly NavItem[] {
  const router = useRouter();
  return useMemo(() => {
    const items: NavItem[] = [];
    for (const route of Object.values(router.routesById)) {
      const data: RouteStaticData | undefined = route.options.staticData;
      if (data === undefined || !hasNav(data)) continue;
      items.push({
        id: route.id,
        to: routePathOf(route.fullPath),
        label: data.nav.label,
        icon: data.nav.icon,
        group: data.nav.group,
        order: data.nav.order,
        requires: data.requires,
        keywords: data.palette?.keywords ?? [],
        key: data.nav.key,
      });
    }
    return items.sort((a, b) =>
      a.group === b.group ? a.order - b.order : a.group === 'primary' ? -1 : 1,
    );
  }, [router]);
}

/** One breadcrumb entry. */
export interface Crumb {
  readonly label: string;
  readonly to: string;
}

/** The route facts breadcrumb derivation needs (a subset of a TanStack route). */
export interface CrumbRoute {
  readonly fullPath: string;
  readonly staticData: RouteStaticData | undefined;
}

function fillParams(pattern: string, params: Readonly<Record<string, string>>): string {
  return pattern
    .split('/')
    .map((segment) =>
      segment.startsWith('$') ? encodeURIComponent(params[segment.slice(1)] ?? '') : segment,
    )
    .join('/');
}

/**
 * Breadcrumb of a page, derived from the URL hierarchy rather than the match tree: one crumb per
 * path prefix that a route declares (`/sessions` → `/sessions/$id` → `/sessions/$id/live`). The
 * app root (`/`, which only redirects) never gets a crumb.
 */
export function deriveCrumbs(
  leafFullPath: string,
  params: Readonly<Record<string, string>>,
  routes: readonly CrumbRoute[],
): readonly Crumb[] {
  const byPath = new Map<string, RouteStaticData>();
  for (const route of routes) {
    const path = routePathOf(route.fullPath);
    if (route.staticData !== undefined && !byPath.has(path)) byPath.set(path, route.staticData);
  }
  const segments = routePathOf(leafFullPath).split('/').filter(Boolean);
  const prefixes = segments.map((_, i) => `/${segments.slice(0, i + 1).join('/')}`);
  const crumbs: Crumb[] = [];
  for (const prefix of prefixes) {
    const data = byPath.get(prefix);
    if (data === undefined) continue;
    const label = data.crumb !== undefined ? data.crumb({ ...params }) : data.title;
    crumbs.push({ label, to: fillParams(prefix, params) });
  }
  return crumbs;
}

/**
 * Topbar rule: a breadcrumb trail only on object pages, i.e. two or more levels deep and not a
 * page of its own in the sidebar (Vault log is a nav page, a session is an object).
 */
export function isObjectPage(crumbs: readonly Crumb[], leafIsNavPage = false): boolean {
  return crumbs.length >= 2 && !leafIsNavPage;
}

/** Title + breadcrumb of the deepest matched route. */
export function usePageIdentity(): {
  readonly title: string;
  readonly crumbs: readonly Crumb[];
  readonly objectPage: boolean;
  readonly notFound: boolean;
} {
  const matches = useMatches();
  const router = useRouter();
  return useMemo(() => {
    const notFound = matches.some((m) => m.status === 'notFound');
    const leaf = matches.at(-1);
    if (leaf === undefined || notFound) {
      return {
        title: notFound ? 'Page not found' : 'BrowserHive',
        crumbs: [],
        objectPage: false,
        notFound,
      };
    }
    const params: Record<string, string> = Object.fromEntries(
      Object.entries(leaf.params as Record<string, unknown>).map(([k, v]) => [k, String(v)]),
    );
    const routes: CrumbRoute[] = Object.values(router.routesById).map((route) => ({
      fullPath: route.fullPath,
      staticData: route.options.staticData,
    }));
    const route = router.routesById[leaf.routeId as keyof typeof router.routesById];
    const crumbs = deriveCrumbs(route?.fullPath ?? leaf.pathname, params, routes);
    const leafIsNavPage = route?.options.staticData?.nav !== undefined;
    return {
      title: crumbs.at(-1)?.label ?? 'BrowserHive',
      crumbs,
      objectPage: isObjectPage(crumbs, leafIsNavPage),
      notFound,
    };
  }, [matches, router]);
}
