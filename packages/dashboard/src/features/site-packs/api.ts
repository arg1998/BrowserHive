/** @module features/site-packs/api — site-pack queries and mutations over `useApi()` + `keys.sitePacks.*` (spec 13 §11.1 "Site packs", T3a): the filtered list, the unfiltered catalog (wizard, template Sites tab, sidebar badge), one pack, a diff, the history and guard hits, and the operator actions (Apply, Reject, Pin, Follow, Enable, Revert, Approve a local file, Reload, Import); every action refreshes the pack queries and the templates that show packs */
import type { SitePackView } from '@browserhive/contracts/http';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { z } from 'zod';
import { useApi } from '@/app/providers/AuthProvider.tsx';
import { useToast } from '@/app/providers/ToastProvider.tsx';
import { toAppError } from '@/lib/api/errors.ts';
import { keys } from '@/lib/api/keys.ts';
import type { SitePackImportBody } from '@/lib/api/operations-site-packs.ts';
import { type SitePacksSearch, toSitePacksQuery } from './search.ts';

/** Rows per page of the history and guard hits. */
export const SITE_PACK_PAGE = 50;

/** `GET /site-packs` with the page's filters (no filter shares the catalog's cache entry). */
export function useSitePacks(search: SitePacksSearch, enabled = true) {
  const api = useApi();
  const query = toSitePacksQuery(search);
  return useQuery({
    queryKey:
      Object.keys(query).length === 0 ? keys.sitePacks.catalog() : keys.sitePacks.list(query),
    queryFn: () => api.listSitePacks({ query }),
    enabled,
    placeholderData: (previous) => previous,
  });
}

/** Every pack, unfiltered: the wizard's catalog, the Sites tab's "use the pack" offer, the badge. */
export function useSitePackCatalog(enabled = true) {
  const api = useApi();
  return useQuery({
    queryKey: keys.sitePacks.catalog(),
    queryFn: () => api.listSitePacks({ query: {} }),
    enabled,
    staleTime: 30_000,
    retry: (count, error) => toAppError(error).status !== 404 && count < 2,
  });
}

/** `GET /site-packs/{id}`. */
export function useSitePack(id: string) {
  const api = useApi();
  return useQuery({
    queryKey: keys.sitePacks.detail(id),
    queryFn: () => api.getSitePack({ params: { pack_id: id } }),
    retry: (count, error) => toAppError(error).status !== 404 && count < 2,
  });
}

/** `GET /site-packs/{id}/diff?to=` (a pending version or `local`). */
export function useSitePackDiff(id: string, to: number | 'local', enabled = true) {
  const api = useApi();
  return useQuery({
    queryKey: keys.sitePacks.diff(id, String(to)),
    queryFn: () => api.diffSitePack({ params: { pack_id: id }, query: { to } }),
    enabled,
    retry: (count, error) => toAppError(error).status >= 500 && count < 2,
  });
}

/** `GET /site-packs/strategies`: the strategy table of the running binary (it changes only with a release). */
export function useSiteStrategies() {
  const api = useApi();
  return useQuery({
    queryKey: keys.sitePacks.strategies(),
    queryFn: () => api.listSiteStrategies(),
    staleTime: Number.POSITIVE_INFINITY,
  });
}

/** `GET /site-packs/changes`, newest first, paged. */
export function useSitePackChanges(packId?: string) {
  const api = useApi();
  const filters = packId === undefined ? {} : { pack_id: packId };
  return useInfiniteQuery({
    queryKey: keys.sitePacks.changes(filters),
    queryFn: ({ pageParam }) =>
      api.listSitePackChanges({
        query: {
          ...filters,
          limit: SITE_PACK_PAGE,
          ...(pageParam !== undefined && { cursor: pageParam }),
        },
      }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.page.next_cursor ?? undefined,
  });
}

/** `GET /site-packs/guard-hits`, newest first, paged. */
export function useSiteGuardHits(action: readonly string[] | undefined) {
  const api = useApi();
  const filters = action === undefined ? {} : { action: [...action] };
  return useInfiniteQuery({
    queryKey: keys.sitePacks.guardHits(filters),
    queryFn: ({ pageParam }) =>
      api.listSiteGuardHits({
        query: {
          ...filters,
          limit: SITE_PACK_PAGE,
          ...(pageParam !== undefined && { cursor: pageParam }),
        },
      }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.page.next_cursor ?? undefined,
  });
}

/** Refresh every pack query and the templates (their sites show the pack in force). */
function useSettle() {
  const qc = useQueryClient();
  return () => {
    void qc.invalidateQueries({ queryKey: keys.sitePacks.all });
    void qc.invalidateQueries({ queryKey: keys.templates.all });
  };
}

/**
 * The operator actions on one pack. Errors toast, except a below-floor refusal of Apply or Approve
 * (`SITE_PACK_BELOW_FLOOR`), which the card explains in place; every action refreshes when it settles.
 */
export function useSitePackActions(packId: string) {
  const api = useApi();
  const toast = useToast();
  const settle = useSettle();
  const params = { pack_id: packId } as const;
  const common = {
    onError: (error: unknown) => {
      const appError = toAppError(error);
      if (appError.code !== 'SITE_PACK_BELOW_FLOOR') toast.fromError(appError);
    },
    onSettled: settle,
  } as const;
  return {
    apply: useMutation({
      mutationFn: (version: number) => api.applySitePack({ params, body: { version } }),
      ...common,
    }),
    reject: useMutation({
      mutationFn: (version: number) => api.rejectSitePack({ params, body: { version } }),
      ...common,
    }),
    pin: useMutation({
      mutationFn: (version: number | null) => api.pinSitePack({ params, body: { version } }),
      ...common,
    }),
    follow: useMutation({
      mutationFn: (follow: boolean | null) => api.followSitePack({ params, body: { follow } }),
      ...common,
    }),
    setEnabled: useMutation({
      mutationFn: (enabled: boolean) =>
        enabled ? api.enableSitePack({ params }) : api.disableSitePack({ params }),
      ...common,
    }),
    revert: useMutation({ mutationFn: () => api.revertSitePack({ params }), ...common }),
    approveLocal: useMutation({
      mutationFn: (sha256: string) => api.approveLocalSitePack({ params, body: { sha256 } }),
      ...common,
    }),
  };
}

/** **Reload local packs** (`POST /site-packs/reload`). */
export function useReloadSitePacks() {
  const api = useApi();
  const toast = useToast();
  const settle = useSettle();
  return useMutation({
    mutationFn: () => api.reloadSitePacks(),
    onError: (error: unknown) => {
      toast.fromError(toAppError(error));
    },
    onSettled: settle,
  });
}

/** **Import…** one unsigned pack file as its exact text (`POST /site-packs/import {text}`); the caller shows `SITE_PACK_INVALID` issues. */
export function useImportSitePack() {
  const api = useApi();
  const settle = useSettle();
  return useMutation({
    mutationFn: (body: z.input<typeof SitePackImportBody>) => api.importSitePack({ body }),
    onSettled: settle,
  });
}

/** Put a returned view into the cached list and catalog at once (the refetch follows). */
export function patchCachedView(qc: ReturnType<typeof useQueryClient>, view: SitePackView): void {
  qc.setQueriesData<{ data: readonly SitePackView[] }>(
    { queryKey: keys.sitePacks.lists() },
    (old) =>
      old === undefined
        ? old
        : { ...old, data: old.data.map((v) => (v.pack_id === view.pack_id ? view : v)) },
  );
}
