/** @module features/site-packs/api — site-pack queries and mutations over `useApi()` + `keys.sitePacks.*` (spec 13 §11.1 "Site packs", T3a, T4b): the filtered list, the unfiltered catalog (wizard, template Sites tab, sidebar badge, the registry status), one pack, a diff, the history and guard hits, and the operator actions (Download & review, Apply, Reject, Pin, Follow, Enable, Revert, Approve a local file, Check now, Download all, Reload, Import of a file or a signed folder); an action's returned view or status goes into the cache at once and every action refreshes the pack queries and the templates that show packs */
import type { SitePackRegistryStatus, SitePackView } from '@browserhive/contracts/http';
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

/** How long a check or Download all may take (each registry fetch is capped at 30 s). */
const REGISTRY_TIMEOUT_MS = 120_000;

/** The registry status of the cached catalog (`undefined` until it loads). */
export function useRegistryStatus(): SitePackRegistryStatus | undefined {
  return useSitePackCatalog().data?.status;
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
 * The operator actions on one pack. Errors toast, except a below-floor refusal of Apply, Approve or
 * Revert (`SITE_PACK_BELOW_FLOOR`), which a dialog explains in place; every action refreshes when it
 * settles.
 */
export function useSitePackActions(packId: string) {
  const api = useApi();
  const qc = useQueryClient();
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
  // Every action answers the pack's new view: show it at once, the refetch follows.
  const viewed = {
    ...common,
    onSuccess: (result: { readonly view: SitePackView }) => patchCachedView(qc, result.view),
  } as const;
  return {
    /** **Download & review**: the verified file and its classified diff, cached for the card at once. */
    download: useMutation({
      mutationFn: (version: number) =>
        api.downloadSitePack({ params, body: { version }, timeoutMs: REGISTRY_TIMEOUT_MS }),
      ...common,
      onSuccess: (result, version) => {
        qc.setQueryData(keys.sitePacks.diff(packId, String(version)), result.diff);
        patchCachedView(qc, result.view);
      },
    }),
    apply: useMutation({
      mutationFn: (version: number) => api.applySitePack({ params, body: { version } }),
      ...viewed,
    }),
    reject: useMutation({
      mutationFn: (version: number) => api.rejectSitePack({ params, body: { version } }),
      ...viewed,
    }),
    pin: useMutation({
      mutationFn: (version: number | null) => api.pinSitePack({ params, body: { version } }),
      ...viewed,
    }),
    follow: useMutation({
      mutationFn: (follow: boolean | null) => api.followSitePack({ params, body: { follow } }),
      ...viewed,
    }),
    setEnabled: useMutation({
      mutationFn: (enabled: boolean) =>
        enabled ? api.enableSitePack({ params }) : api.disableSitePack({ params }),
      ...viewed,
    }),
    revert: useMutation({ mutationFn: () => api.revertSitePack({ params }), ...viewed }),
    approveLocal: useMutation({
      mutationFn: (sha256: string) => api.approveLocalSitePack({ params, body: { sha256 } }),
      ...viewed,
    }),
  };
}

/** One version Apply selected applies. */
export interface SelectedVersion {
  readonly packId: string;
  readonly title: string;
  readonly version: number;
}

/** What Apply selected did: the versions applied and the ones refused, with why. */
export interface ApplySelectedResult {
  readonly applied: readonly SelectedVersion[];
  readonly failed: readonly {
    readonly item: SelectedVersion;
    readonly code: string;
    readonly message: string;
  }[];
}

/** **Apply selected**: the chosen downloaded versions one after the other (a refusal never stops the rest). */
export function useApplySelected() {
  const api = useApi();
  const qc = useQueryClient();
  const settle = useSettle();
  return useMutation({
    mutationFn: async (items: readonly SelectedVersion[]): Promise<ApplySelectedResult> => {
      const applied: SelectedVersion[] = [];
      const failed: { item: SelectedVersion; code: string; message: string }[] = [];
      for (const item of items) {
        try {
          const { view } = await api.applySitePack({
            params: { pack_id: item.packId },
            body: { version: item.version },
          });
          patchCachedView(qc, view);
          applied.push(item);
        } catch (error) {
          const e = toAppError(error);
          failed.push({ item, code: e.code, message: e.message });
        }
      }
      return { applied, failed };
    },
    onSettled: settle,
  });
}

/** Put a status (a check's, a live event's) into every cached list at once. */
export function patchCachedStatus(
  qc: ReturnType<typeof useQueryClient>,
  status: SitePackRegistryStatus,
): void {
  qc.setQueriesData<{ status: SitePackRegistryStatus }>(
    { queryKey: keys.sitePacks.lists() },
    (old) => (old === undefined ? old : { ...old, status }),
  );
}

/**
 * **Check now** (`POST /site-packs/check`, 6/min): a failed fetch is an answer (`outcome: failed`),
 * not an error; the caller toasts the outcome and a 429 (`RATE_LIMITED`).
 */
export function useCheckSitePacks() {
  const api = useApi();
  const qc = useQueryClient();
  const settle = useSettle();
  return useMutation({
    mutationFn: () => api.checkSitePacks({ timeoutMs: REGISTRY_TIMEOUT_MS }),
    onSuccess: (result) => patchCachedStatus(qc, result.status),
    onSettled: settle,
  });
}

/** **Download all** (`POST /site-packs/download-all`): every listed version the client lacks, all packs. */
export function useDownloadAllSitePacks() {
  const api = useApi();
  const toast = useToast();
  const settle = useSettle();
  return useMutation({
    mutationFn: () => api.downloadAllSitePacks({ timeoutMs: REGISTRY_TIMEOUT_MS }),
    onError: (error: unknown) => {
      toast.fromError(toAppError(error));
    },
    onSettled: settle,
  });
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

/** **Import…** one unsigned pack file as its exact text (`POST /site-packs/import {text}`) or a signed folder (`{files, name}`); the caller shows the result and `SITE_PACK_INVALID` issues. */
export function useImportSitePack() {
  const api = useApi();
  const settle = useSettle();
  return useMutation({
    mutationFn: (body: z.input<typeof SitePackImportBody>) => api.importSitePack({ body }),
    onSettled: settle,
  });
}

/** Put a returned view into the cached lists, the catalog and the pack's page at once (the refetch follows). */
export function patchCachedView(qc: ReturnType<typeof useQueryClient>, view: SitePackView): void {
  qc.setQueriesData<{ data: readonly SitePackView[] }>(
    { queryKey: keys.sitePacks.lists() },
    (old) =>
      old === undefined
        ? old
        : { ...old, data: old.data.map((v) => (v.pack_id === view.pack_id ? view : v)) },
  );
  qc.setQueryData<{ view: SitePackView }>(keys.sitePacks.detail(view.pack_id), (old) =>
    old === undefined ? old : { ...old, view },
  );
}
