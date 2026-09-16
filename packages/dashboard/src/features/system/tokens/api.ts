/** @module features/system/tokens/api — API tokens: list (`GET /auth/tokens`), create (plaintext never cached), revoke with optimistic removal + rollback (spec 03 §4.1, spec 04 §11) */
import type { ApiTokenList, CreateTokenResponse } from '@browserhive/contracts/http';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback } from 'react';
import { useApi } from '@/app/providers/AuthProvider.tsx';
import { useToast } from '@/app/providers/ToastProvider.tsx';
import { isAppError, toAppError } from '@/lib/api/errors.ts';
import { keys } from '@/lib/api/keys.ts';

/** `GET /auth/tokens`. */
export function useTokens() {
  const api = useApi();
  return useQuery({ queryKey: keys.auth.tokens(), queryFn: () => api.listTokens() });
}

/** True when the error is an authorization refusal (the caller is not an operator). */
export function isForbidden(error: unknown): boolean {
  return isAppError(error) && error.status === 403;
}

/**
 * `POST /auth/tokens` for an agent principal. The response carries the plaintext token, so the
 * mutation is never retained (`gcTime: 0`) and `forget()` drops it from the mutation cache; the
 * caller keeps the only copy in component state until the dialog closes.
 */
export function useCreateToken(onCreated: (created: CreateTokenResponse, display: string) => void) {
  const api = useApi();
  const queryClient = useQueryClient();
  const toast = useToast();
  const mutation = useMutation({
    mutationKey: keys.auth.tokenCreate(),
    gcTime: 0,
    mutationFn: (display: string) => api.createToken({ body: { owner_kind: 'agent', display } }),
    onSuccess: (created, display) => onCreated(created, display),
    onError: (error) => toast.fromError(toAppError(error), 'Could not create token'),
    onSettled: () => queryClient.invalidateQueries({ queryKey: keys.auth.tokens() }),
  });
  const { reset } = mutation;
  const forget = useCallback(() => {
    reset();
    const cache = queryClient.getMutationCache();
    for (const entry of cache.findAll({ mutationKey: keys.auth.tokenCreate() })) {
      cache.remove(entry);
    }
  }, [queryClient, reset]);
  return { create: mutation.mutate, isPending: mutation.isPending, forget };
}

/** `DELETE /auth/tokens/{credential_id}`: removes the row at once, restores it and toasts on failure. */
export function useRevokeToken() {
  const api = useApi();
  const queryClient = useQueryClient();
  const toast = useToast();
  return useMutation({
    mutationFn: (credentialId: string) =>
      api.revokeToken({ params: { credential_id: credentialId } }),
    onMutate: async (credentialId) => {
      await queryClient.cancelQueries({ queryKey: keys.auth.tokens() });
      const previous = queryClient.getQueryData<ApiTokenList>(keys.auth.tokens());
      if (previous !== undefined) {
        queryClient.setQueryData<ApiTokenList>(keys.auth.tokens(), {
          ...previous,
          data: previous.data.filter((t) => t.credential_id !== credentialId),
        });
      }
      return { previous };
    },
    onError: (error, _id, context) => {
      if (context?.previous !== undefined) {
        queryClient.setQueryData(keys.auth.tokens(), context.previous);
      }
      toast.fromError(toAppError(error), 'Could not revoke token');
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: keys.auth.tokens() }),
  });
}
