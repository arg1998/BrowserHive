/** @module features/templates/api-operations — the template operations of spec 13 §11.1 beyond creation and recording (browser start/stop/restart, enable/disable, field and site changes, versions, restore, seed, the access tester, data-dir reveal) as queries and mutations over `useApi()` */
import type {
  PutTemplateSiteRequest,
  ResolveTemplateAccessRequest,
  TemplatePatchInput,
  TemplateStorageState,
} from '@browserhive/contracts/http';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { z } from 'zod';
import { useApi } from '@/app/providers/AuthProvider.tsx';
import { useToast } from '@/app/providers/ToastProvider.tsx';
import { toAppError } from '@/lib/api/errors.ts';
import { keys } from '@/lib/api/keys.ts';
import { TEMPLATES_LIVE } from './live.ts';

/** How often a running restore or seed is re-read (the topic's `template.operation` also refreshes it). */
export const OPERATION_POLL_MS = TEMPLATES_LIVE ? 5_000 : 1_500;

/** Browser actions (`POST /templates/{id}/host/{action}`). */
export type HostAction = 'start' | 'stop' | 'restart';

/** A template edit (`PATCH /templates/{id}`). */
export type TemplatePatch = z.input<typeof TemplatePatchInput>;

/** `GET /templates/{id}/versions` (first page) with the rolling checkpoint. */
export function useTemplateVersions(id: string, enabled = true) {
  const api = useApi();
  return useQuery({
    queryKey: keys.templates.versions(id),
    queryFn: () => api.listTemplateVersions({ params: { template_id: id }, query: { limit: 50 } }),
    enabled,
    retry: (count, error) => toAppError(error).status !== 404 && count < 2,
  });
}

/** A restore or seed until it settles. */
export function useTemplateOperation(operationId: string | null) {
  const api = useApi();
  return useQuery({
    queryKey: keys.templates.operation(operationId ?? ''),
    queryFn: () => api.getTemplateOperation({ params: { operation_id: operationId ?? '' } }),
    enabled: operationId !== null,
    refetchInterval: (query) =>
      query.state.data === undefined || query.state.data.state === 'running'
        ? OPERATION_POLL_MS
        : false,
  });
}

/** The operator mutations of one template. Each one invalidates the template queries when it settles. */
export function useTemplateOperations(id: string) {
  const api = useApi();
  const qc = useQueryClient();
  const toast = useToast();
  const params = { template_id: id } as const;
  const settle = () => qc.invalidateQueries({ queryKey: keys.templates.all });
  const onError = (error: unknown) => {
    toast.fromError(toAppError(error));
  };
  const common = { onError, onSettled: settle } as const;
  const hostCall = (action: HostAction) =>
    action === 'start'
      ? api.startTemplateHost({ params })
      : action === 'stop'
        ? api.stopTemplateHost({ params })
        : api.restartTemplateHost({ params });
  return {
    host: useMutation({ mutationFn: hostCall, ...common }),
    setEnabled: useMutation({
      mutationFn: (enabled: boolean) =>
        enabled ? api.enableTemplate({ params }) : api.disableTemplate({ params }),
      ...common,
    }),
    patch: useMutation({
      mutationFn: (input: { readonly patch: TemplatePatch; readonly ifMatch: number }) =>
        api.updateTemplate({ params, body: input.patch, ifMatch: input.ifMatch }),
      ...common,
    }),
    putSite: useMutation({
      mutationFn: (input: {
        readonly site: string;
        readonly body: z.input<typeof PutTemplateSiteRequest>;
      }) =>
        api.putTemplateSite({ params: { template_id: id, site_id: input.site }, body: input.body }),
      ...common,
    }),
    deleteSite: useMutation({
      mutationFn: (site: string) =>
        api.deleteTemplateSite({ params: { template_id: id, site_id: site } }),
      ...common,
    }),
    closeParkedPage: useMutation({
      mutationFn: (targetId: string) =>
        api.closeTemplatePage({ params: { template_id: id, target_id: targetId } }),
      ...common,
    }),
    saveVersion: useMutation({ mutationFn: () => api.saveTemplateVersion({ params }), ...common }),
    pinVersion: useMutation({
      mutationFn: (input: { readonly version: number; readonly pinned: boolean }) =>
        api.updateTemplateVersion({
          params: { template_id: id, version: input.version },
          body: { pinned: input.pinned },
        }),
      ...common,
    }),
    /** Errors are the caller's (409s are explained in the dialog). */
    restore: useMutation({
      mutationFn: (input: { readonly version: number | 'latest'; readonly forceClose: boolean }) =>
        api.restoreTemplateVersion({
          params: { template_id: id, version: input.version },
          body: { force_close: input.forceClose },
        }),
      onSettled: settle,
    }),
    /** Errors are the caller's. `confirm` is required over a ready template. */
    seed: useMutation({
      mutationFn: (input: {
        readonly state: z.input<typeof TemplateStorageState>;
        readonly confirm: boolean;
      }) => api.seedTemplate({ params, query: { confirm: input.confirm }, body: input.state }),
      onSettled: settle,
    }),
    resolveAccess: useMutation({
      mutationFn: (probe: z.input<typeof ResolveTemplateAccessRequest>) =>
        api.resolveTemplateAccess({ params, body: probe }),
    }),
    reveal: useMutation({ mutationFn: () => api.revealTemplateDataDir({ params }), onError }),
  };
}
