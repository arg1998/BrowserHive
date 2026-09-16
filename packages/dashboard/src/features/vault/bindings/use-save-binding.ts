/** @module features/vault/bindings/use-save-binding — optimistic binding save with `If-Match` + snapshot rollback that surfaces `CONFLICT` with the server version; confirmed delete */
import type { VaultBinding } from '@browserhive/contracts/http';
import { type QueryKey, useMutation, useQueryClient } from '@tanstack/react-query';
import { useApi } from '@/app/providers/AuthProvider.tsx';
import { useToast } from '@/app/providers/ToastProvider.tsx';
import { type AppError, toAppError } from '@/lib/api/errors.ts';
import { keys } from '@/lib/api/keys.ts';
import { useServerClock } from '@/lib/server-now.ts';
import { patchRow } from '@/lib/ws/bridge.ts';
import { type BindingFormValues, optimisticBinding, toPutBody } from './binding-form.ts';

/** Save input: `previous` is the row the editor opened (absent on create). */
export interface SaveBindingInput {
  readonly values: BindingFormValues;
  readonly previous?: VaultBinding | undefined;
}

/** A rolled-back edit the panel shows until dismissed or retried. */
export interface BindingConflict {
  readonly handle: string;
  /** Version the edit was based on. */
  readonly baseVersion: number | null;
  /** Version the server holds now (`details.current_version`), when reported. */
  readonly serverVersion: number | null;
  readonly values: BindingFormValues;
}

/** `true` for an optimistic-concurrency failure (registry `CONFLICT`; 409 in the registry, 412 over HTTP). */
export function isConflict(error: AppError): boolean {
  return error.code === 'CONFLICT' || error.status === 412;
}

/** Server version reported by a conflict, if any. */
export function conflictVersion(error: AppError): number | null {
  const value = error.details['current_version'];
  return typeof value === 'number' ? value : null;
}

type Snapshot = readonly (readonly [QueryKey, unknown])[];

/** Save a binding optimistically (edits patch the cached row in place; creates wait for the server row). */
export function useSaveBinding(onConflict: (conflict: BindingConflict) => void) {
  const api = useApi();
  const qc = useQueryClient();
  const toast = useToast();
  const clock = useServerClock();
  return useMutation({
    mutationFn: ({ values, previous }: SaveBindingInput) =>
      api.putVaultBinding({
        params: { handle: values.handle },
        body: toPutBody(values),
        ...(previous !== undefined && { ifMatch: previous.version }),
      }),
    onMutate: async ({ values, previous }) => {
      await qc.cancelQueries({ queryKey: ['vault', 'bindings'] });
      const snapshot: Snapshot = qc.getQueriesData({ queryKey: ['vault', 'bindings'] });
      if (previous !== undefined) {
        const next = optimisticBinding(previous, values, clock.now());
        patchRow(qc, ['vault', 'bindings'], 'handle', previous.handle, { ...next });
      }
      return { snapshot };
    },
    onError: (raw, { values, previous }, context) => {
      if (context !== undefined)
        for (const [key, data] of context.snapshot) qc.setQueryData(key, data);
      const error = toAppError(raw);
      if (isConflict(error)) {
        onConflict({
          handle: values.handle,
          baseVersion: previous?.version ?? null,
          serverVersion: conflictVersion(error),
          values,
        });
      }
      toast.fromError(
        error,
        isConflict(error) ? 'Binding changed on the server' : 'Could not save the binding',
      );
    },
    onSuccess: ({ binding }) => {
      patchRow(qc, ['vault', 'bindings'], 'handle', binding.handle, { ...binding });
    },
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: ['vault', 'bindings'] });
      void qc.invalidateQueries({ queryKey: keys.vault.state() });
      void qc.invalidateQueries({ queryKey: keys.vault.groups() });
    },
  });
}

/** Delete a binding (the caller confirms first; waits for the server). */
export function useDeleteBinding() {
  const api = useApi();
  const qc = useQueryClient();
  const toast = useToast();
  return useMutation({
    mutationFn: (handle: string) => api.deleteVaultBinding({ params: { handle } }),
    onSuccess: (_result, handle) => toast.success({ title: `Binding ${handle} deleted` }),
    onError: (error) => toast.fromError(toAppError(error), 'Could not delete the binding'),
    onSettled: () => void qc.invalidateQueries({ queryKey: keys.vault.all }),
  });
}
