/** @module features/templates/api-operations — the template operations T1b serves (spec 13 §11.1: browser start/stop/restart, enable/disable, field and site changes, versions, restore, seed, the access tester, data-dir reveal) as queries and mutations; the calls go through `pending/client.ts` until the contracts export them */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useToast } from '@/app/providers/ToastProvider.tsx';
import { toAppError } from '@/lib/api/errors.ts';
import { keys } from '@/lib/api/keys.ts';
import {
  type AccessProbe,
  type HostAction,
  isRouteMissing,
  type TemplatePatch,
  usePendingTemplateApi,
} from './pending/client.ts';
import type { PutSiteRequest } from './pending/contracts.ts';

/** How often a running restore or seed is re-read while the `templates` topic is not served. */
export const OPERATION_POLL_MS = 1_500;

/** `GET /templates/{id}/versions` (first page) with the rolling checkpoint. */
export function useTemplateVersions(id: string, enabled = true) {
  const pending = usePendingTemplateApi();
  return useQuery({
    queryKey: keys.templates.versions(id),
    queryFn: () => pending.listVersions(id),
    enabled,
    retry: (count, error) =>
      !isRouteMissing(error) && toAppError(error).status !== 404 && count < 2,
  });
}

/** A restore or seed until it settles (polled; the topic's `template.operation` also invalidates it). */
export function useTemplateOperation(operationId: string | null) {
  const pending = usePendingTemplateApi();
  return useQuery({
    queryKey: keys.templates.operation(operationId ?? ''),
    queryFn: () => pending.operation(operationId ?? ''),
    enabled: operationId !== null,
    refetchInterval: (query) =>
      query.state.data === undefined || query.state.data.state === 'running'
        ? OPERATION_POLL_MS
        : false,
  });
}

/** The operator mutations of one template. Each one invalidates every template query when it settles. */
export function useTemplateOperations(id: string) {
  const pending = usePendingTemplateApi();
  const qc = useQueryClient();
  const toast = useToast();
  const settle = () => qc.invalidateQueries({ queryKey: keys.templates.all });
  const onError = (error: unknown) => {
    toast.fromError(toAppError(error));
  };
  const common = { onError, onSettled: settle } as const;
  return {
    host: useMutation({ mutationFn: (action: HostAction) => pending.host(id, action), ...common }),
    setEnabled: useMutation({
      mutationFn: (enabled: boolean) => pending.setEnabled(id, enabled),
      ...common,
    }),
    patch: useMutation({
      mutationFn: (input: { readonly patch: TemplatePatch; readonly ifMatch: number }) =>
        pending.patchTemplate(id, input.patch, input.ifMatch),
      ...common,
    }),
    putSite: useMutation({
      mutationFn: (input: { readonly site: string; readonly body: PutSiteRequest }) =>
        pending.putSite(id, input.site, input.body),
      ...common,
    }),
    deleteSite: useMutation({
      mutationFn: (site: string) => pending.deleteSite(id, site),
      ...common,
    }),
    closeParkedPage: useMutation({
      mutationFn: (targetId: string) => pending.closeParkedPage(id, targetId),
      ...common,
    }),
    saveVersion: useMutation({ mutationFn: () => pending.saveVersion(id), ...common }),
    pinVersion: useMutation({
      mutationFn: (input: { readonly version: number; readonly pinned: boolean }) =>
        pending.pinVersion(id, input.version, input.pinned),
      ...common,
    }),
    restore: useMutation({
      mutationFn: (input: { readonly version: number | 'latest'; readonly forceClose: boolean }) =>
        pending.restoreVersion(id, input.version, input.forceClose),
      ...common,
    }),
    seed: useMutation({
      mutationFn: (input: { readonly state: unknown; readonly confirm: boolean }) =>
        pending.seed(id, input.state, input.confirm),
      ...common,
    }),
    resolveAccess: useMutation({
      mutationFn: (probe: AccessProbe) => pending.resolveAccess(id, probe),
    }),
    reveal: useMutation({ mutationFn: () => pending.revealDataDir(id), onError }),
  };
}
