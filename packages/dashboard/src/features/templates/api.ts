/** @module features/templates/api — template queries and the T1a mutations over `useApi()` + `keys.templates.*` (spec 13 §11.1, spec 04 §5): list, detail, create, delete, recording (start, I'm signed in, finish, cancel), removing an unlisted sign-in, clearing saved passwords; live through `useTemplatesLive` */
import type { TemplateInput } from '@browserhive/contracts/http';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useApi } from '@/app/providers/AuthProvider.tsx';
import { useToast } from '@/app/providers/ToastProvider.tsx';
import { toAppError } from '@/lib/api/errors.ts';
import { keys } from '@/lib/api/keys.ts';
import { type TemplatesSearch, toTemplatesQuery } from './search.ts';

/** How often an open sign-in step re-reads the template while the `templates` topic is not served. */
export const SIGN_IN_POLL_MS = 5_000;

/** One page of `GET /templates`. */
export function useTemplatesList(
  search: TemplatesSearch,
  cursor: string | undefined,
  enabled = true,
) {
  const api = useApi();
  const query = toTemplatesQuery(search, cursor);
  return useQuery({
    queryKey: keys.templates.list(query),
    queryFn: () => api.listTemplates({ query }),
    enabled,
    placeholderData: (previous) => previous,
  });
}

/** Every template, unfiltered (sidebar badge, `/system` browsers, the Template chip of `/sessions`). */
export function useTemplatesOverview(enabled = true) {
  const api = useApi();
  return useQuery({
    queryKey: keys.templates.overview(),
    queryFn: () => api.listTemplates({ query: { limit: 200, sort: 'name', dir: 'asc' } }),
    enabled,
  });
}

/** `GET /templates/{id}`; `poll` re-reads it every few seconds (the sign-in step without the topic). */
export function useTemplateDetail(
  id: string | undefined,
  options: { readonly poll?: boolean } = {},
) {
  const api = useApi();
  return useQuery({
    queryKey: keys.templates.detail(id ?? ''),
    queryFn: () => api.getTemplate({ params: { template_id: id ?? '' } }),
    enabled: id !== undefined,
    retry: (count, error) => toAppError(error).status !== 404 && count < 2,
    ...(options.poll === true && { refetchInterval: SIGN_IN_POLL_MS }),
  });
}

/** Invalidate every template query (after a change made here or reported by the server). */
export function useInvalidateTemplates() {
  const qc = useQueryClient();
  return () => qc.invalidateQueries({ queryKey: keys.templates.all });
}

/** `POST /templates` (the wizard's step 4 → 5). Errors are shown by the caller, field by field. */
export function useCreateTemplate() {
  const api = useApi();
  const invalidate = useInvalidateTemplates();
  return useMutation({
    mutationFn: (body: TemplateInput) => api.createTemplate({ body }),
    onSuccess: () => void invalidate(),
  });
}

/** The T1a operations on one template; errors toast unless the caller handles them. */
export function useTemplateMutations(id: string) {
  const api = useApi();
  const qc = useQueryClient();
  const toast = useToast();
  const params = { template_id: id } as const;
  const settle = () => qc.invalidateQueries({ queryKey: keys.templates.all });
  const onError = (error: unknown) => {
    toast.fromError(toAppError(error));
  };
  return {
    remove: useMutation({
      mutationFn: (force: boolean) => api.deleteTemplate({ params, query: { force } }),
      onError,
      onSuccess: () => {
        qc.removeQueries({ queryKey: keys.templates.detail(id) });
        void qc.invalidateQueries({ queryKey: keys.templates.lists() });
        void qc.invalidateQueries({ queryKey: keys.templates.overview() });
      },
    }),
    /** Errors are the caller's: the sign-in step turns them into its error states. */
    startRecording: useMutation({
      mutationFn: (sites?: readonly string[]) =>
        api.startTemplateRecording({
          params,
          body: sites === undefined ? {} : { sites: [...sites] },
        }),
      onSettled: settle,
    }),
    confirm: useMutation({
      mutationFn: (siteId: string) =>
        api.confirmTemplateRecording({ params, body: { site_id: siteId } }),
      onSettled: settle,
    }),
    finish: useMutation({
      mutationFn: (removeSignIns: readonly string[]) =>
        api.finishTemplateRecording({ params, body: { remove_sign_ins: [...removeSignIns] } }),
      onError,
      onSettled: settle,
    }),
    cancel: useMutation({
      mutationFn: () => api.cancelTemplateRecording({ params }),
      onError,
      onSettled: settle,
    }),
    removeSignIn: useMutation({
      mutationFn: (domain: string) =>
        api.removeTemplateSignIn({ params: { template_id: id, domain } }),
      onError,
      onSettled: settle,
    }),
    clearProfileSecrets: useMutation({
      mutationFn: () => api.clearTemplateProfileSecrets({ params }),
      onError,
      onSettled: settle,
    }),
  };
}
