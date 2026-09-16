/** @module features/vault/confirm/use-resolve-confirm — optimistic approve/deny of a held `vault_fill` with snapshot rollback and an error toast (spec 04 §11) */
import type { OperatorRequestRow, VaultConfirmDecision } from '@browserhive/contracts/http';
import { type QueryKey, useMutation, useQueryClient } from '@tanstack/react-query';
import { useApi } from '@/app/providers/AuthProvider.tsx';
import { useToast } from '@/app/providers/ToastProvider.tsx';
import { toAppError } from '@/lib/api/errors.ts';
import { keys } from '@/lib/api/keys.ts';
import { removeRow } from '@/lib/ws/bridge.ts';

/** Approve/deny input. */
export interface ResolveConfirmInput {
  readonly requestId: OperatorRequestRow['request_id'];
  readonly decision: VaultConfirmDecision;
  readonly reason?: string;
}

type Snapshot = readonly (readonly [QueryKey, unknown])[];

/** Optimistic resolve: the row leaves the queue at once; failure restores the snapshot and toasts the code. */
export function useResolveConfirm() {
  const api = useApi();
  const qc = useQueryClient();
  const toast = useToast();
  return useMutation({
    mutationFn: ({ requestId, decision, reason }: ResolveConfirmInput) =>
      api.resolveVaultConfirm({
        params: { request_id: requestId },
        body: { decision, ...(reason !== undefined && reason !== '' && { reason }) },
      }),
    onMutate: async ({ requestId }) => {
      await qc.cancelQueries({ queryKey: keys.vault.confirms() });
      const snapshot: Snapshot = [
        ...qc.getQueriesData({ queryKey: keys.vault.confirms() }),
        ...qc.getQueriesData({ queryKey: keys.vault.confirmCount() }),
      ];
      removeRow(qc, keys.vault.confirms(), 'request_id', requestId);
      const count = qc.getQueryData(keys.vault.confirmCount());
      if (typeof count === 'number')
        qc.setQueryData(keys.vault.confirmCount(), Math.max(0, count - 1));
      return { snapshot };
    },
    onError: (error, input, context) => {
      if (context !== undefined)
        for (const [key, data] of context.snapshot) qc.setQueryData(key, data);
      toast.fromError(
        toAppError(error),
        input.decision === 'approve' ? 'Approve failed' : 'Deny failed',
      );
    },
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: keys.vault.confirms() });
      void qc.invalidateQueries({ queryKey: keys.vault.confirmCount() });
    },
  });
}

/** Bulk approve/deny over the queue; the toast names ok/failed counts. */
export function useBulkConfirm() {
  const api = useApi();
  const qc = useQueryClient();
  const toast = useToast();
  return useMutation({
    mutationFn: (input: {
      readonly action: VaultConfirmDecision;
      readonly requestIds: readonly OperatorRequestRow['request_id'][];
      readonly reason?: string;
    }) =>
      api.bulkVaultConfirm({
        body: {
          action: input.action,
          request_ids: [...input.requestIds],
          ...(input.reason !== undefined && input.reason !== '' && { reason: input.reason }),
        },
        idempotencyKey: globalThis.crypto.randomUUID(),
      }),
    onSuccess: (result, input) => {
      const verb = input.action === 'approve' ? 'approved' : 'denied';
      const title = `${result.ok_count} ${verb}${result.error_count > 0 ? `, ${result.error_count} failed` : ''}`;
      if (result.error_count > 0) toast.warning({ title });
      else toast.success({ title });
    },
    onError: (error) => toast.fromError(toAppError(error), 'Bulk action failed'),
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: keys.vault.confirms() });
      void qc.invalidateQueries({ queryKey: keys.vault.confirmCount() });
    },
  });
}
