/** @module features/templates/api-health — health and re-login over `useApi()` (spec 13 §8, §11.1, PR T2): the probe history, **Check now**, re-login by window or vault (start, I'm signed in, cancel), **Show window**, **Let agents continue** (each refusal titled by its own action), and linking a vault binding for automatic re-login */
import type { PutReloginLinkRequest, TemplateProbesQuery } from '@browserhive/contracts/http';
import {
  useInfiniteQuery,
  useIsMutating,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import type { z } from 'zod';
import { useApi } from '@/app/providers/AuthProvider.tsx';
import { useToast } from '@/app/providers/ToastProvider.tsx';
import { type AppError, toAppError } from '@/lib/api/errors.ts';
import { keys } from '@/lib/api/keys.ts';

/** Probes per page on the Activity tab. */
export const PROBES_LIMIT = 50;
/** **Check now** waits for the probes (the server gives up after 120 s). */
export const PROBE_TIMEOUT_MS = 125_000;

/** The probe history filters (`GET /templates/{id}/probes`). */
export type ProbeFilters = Pick<
  z.input<typeof TemplateProbesQuery>,
  'site_id' | 'outcome' | 'trigger'
>;

/** `GET /templates/{id}/probes`, newest first, a page at a time. */
export function useTemplateProbes(id: string, filters: ProbeFilters) {
  const api = useApi();
  return useInfiniteQuery({
    queryKey: keys.templates.probes(id, filters),
    queryFn: ({ pageParam }) =>
      api.listTemplateProbes({
        params: { template_id: id },
        query: {
          ...filters,
          limit: PROBES_LIMIT,
          ...(pageParam !== undefined && { cursor: pageParam }),
        },
      }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.page.next_cursor ?? undefined,
  });
}

/** `GET /vault/bindings` (first 200, by handle) for the binding picker; only while the vault is on. */
export function useBindingChoices(enabled: boolean) {
  const api = useApi();
  const query = { limit: 200, sort: 'handle', dir: 'asc' } as const;
  return useQuery({
    queryKey: keys.vault.bindings({ ...query, picker: true }),
    queryFn: () => api.listVaultBindings({ query }),
    enabled,
    staleTime: 30_000,
  });
}

/** A refusal of the re-login routes in words: the server's own reason (a 409 says what is in the way), or the scope a 403 lacks. */
export function reloginRefusal(error: AppError): string {
  if (error.status === 403)
    return 'Your account can’t sign this template in again (it needs templates:login).';
  return error.message;
}

/** The toast title of each re-login mutation's refusal (review #81 M-6: one per mutation). */
export const RELOGIN_REFUSAL_TITLE = {
  confirm: 'The re-login isn’t finished',
  cancel: 'The re-login wasn’t cancelled',
  continueAgents: 'Agents still wait',
} as const;

/** The pending **Check now** / **Check all now** of a template, shared by every button (L-16). */
export function useProbePending(id: string): boolean {
  return useIsMutating({ mutationKey: keys.templates.probeRun(id) }) > 0;
}

/** The health and re-login mutations of one template; each refreshes the template when it settles. */
export function useTemplateHealth(id: string) {
  const api = useApi();
  const qc = useQueryClient();
  const toast = useToast();
  const params = { template_id: id } as const;
  const settle = () => {
    void qc.invalidateQueries({ queryKey: keys.templates.detail(id) });
    void qc.invalidateQueries({ queryKey: keys.templates.lists() });
    void qc.invalidateQueries({ queryKey: keys.templates.overview() });
  };
  const refused = (action: keyof typeof RELOGIN_REFUSAL_TITLE) => ({
    onError: (error: unknown) => {
      const appError = toAppError(error);
      toast.error({
        title: RELOGIN_REFUSAL_TITLE[action],
        description: reloginRefusal(appError),
        code: appError.code,
        ...(appError.requestId !== undefined && { requestId: appError.requestId }),
      });
    },
    onSettled: settle,
  });
  return {
    probe: useMutation({
      mutationKey: keys.templates.probeRun(id),
      mutationFn: (siteIds?: readonly string[]) =>
        api.probeTemplate({
          params,
          body: siteIds === undefined ? {} : { site_ids: [...siteIds] },
          timeoutMs: PROBE_TIMEOUT_MS,
        }),
      onError: (error: unknown) => toast.fromError(toAppError(error), 'The check didn’t run'),
      onSettled: () => {
        settle();
        void qc.invalidateQueries({ queryKey: keys.templates.probesOf(id) });
      },
    }),
    /** Errors are the caller's (the dialog explains them). */
    start: useMutation({
      mutationFn: (input: {
        readonly site: string;
        readonly method: 'window' | 'vault';
        readonly letAgentsContinue: boolean;
      }) =>
        api.startTemplateRelogin({
          params,
          body: {
            site_id: input.site,
            method: input.method,
            let_agents_continue: input.letAgentsContinue,
          },
        }),
      onSettled: settle,
    }),
    confirm: useMutation({
      mutationFn: (site: string) => api.confirmTemplateRelogin({ params, body: { site_id: site } }),
      ...refused('confirm'),
    }),
    cancel: useMutation({
      mutationFn: () => api.cancelTemplateRelogin({ params }),
      ...refused('cancel'),
    }),
    show: useMutation({
      mutationFn: () => api.showTemplateWindow({ params }),
      onError: (error: unknown) => {
        const appError = toAppError(error);
        toast.fromError(
          appError,
          appError.status === 409 ? 'No sign-in window is waiting' : 'The window didn’t open',
        );
      },
      onSettled: settle,
    }),
    continueAgents: useMutation({
      mutationFn: () => api.continueTemplateAgents({ params }),
      ...refused('continueAgents'),
    }),
    /** Errors are the caller's (403 needs `vault:write` as well). */
    link: useMutation({
      mutationFn: (input: {
        readonly site: string;
        readonly body: z.input<typeof PutReloginLinkRequest>;
      }) =>
        api.putTemplateReloginLink({
          params: { template_id: id, site_id: input.site },
          body: input.body,
        }),
      onSettled: () => {
        settle();
        void qc.invalidateQueries({ queryKey: keys.vault.all });
      },
    }),
  };
}
