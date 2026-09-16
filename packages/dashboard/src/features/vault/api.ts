/** @module features/vault/api — vault queries (overview, status, groups, items, bindings, confirms) and the non-optimistic mutations (unlock, lock, sync, policy, import) (spec 03 §4.5, spec 04 §12.7) */
import type {
  PutGroupPolicyRequest,
  UnlockVaultRequest,
  VaultBindingsQuery,
  VaultExportDocument,
} from '@browserhive/contracts/http';
import { UNGROUPED_GROUP_KEY } from '@browserhive/contracts/http';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { z } from 'zod';
import { useApi } from '@/app/providers/AuthProvider.tsx';
import { useToast } from '@/app/providers/ToastProvider.tsx';
import type { CursorPager } from '@/components/shared/use-cursor-pages.ts';
import { isAppError, toAppError } from '@/lib/api/errors.ts';
import { keys } from '@/lib/api/keys.ts';

/** Most pending confirms the queue renders. */
export const CONFIRM_LIMIT = 100;
/** Bindings fetched per page. */
export const BINDINGS_LIMIT = 50;

/** `true` when the error says the vault backend is off (distinct from transient errors). */
export function isVaultOff(error: unknown): boolean {
  return isAppError(error) && error.code === 'VAULT_NOT_CONFIGURED';
}

/** `GET /vault` — backend kind, capabilities, unlock descriptor; never shells out. */
export function useVaultOverview(enabled = true) {
  const api = useApi();
  return useQuery({
    enabled,
    queryKey: keys.vault.state(),
    queryFn: () => api.getVault(),
    retry: (count, error) => !isVaultOff(error) && count < 2,
  });
}

/** `GET /vault/status` — may call the backend; only asked once the overview exists. */
export function useVaultStatus(enabled: boolean) {
  const api = useApi();
  return useQuery({ queryKey: keys.vault.status(), queryFn: () => api.getVaultStatus(), enabled });
}

/** Groups with their policies (needs an unlocked backend). */
export function useVaultGroups(enabled: boolean) {
  const api = useApi();
  return useQuery({ queryKey: keys.vault.groups(), queryFn: () => api.listVaultGroups(), enabled });
}

/** Backend items, optionally within a group (needs an unlocked backend). */
export function useVaultItems(groupId: string | null | undefined, enabled: boolean) {
  const api = useApi();
  const query = {
    limit: 500,
    ...(groupId !== null && groupId !== undefined && { group_id: groupId }),
  };
  return useQuery({
    queryKey: keys.vault.items(query),
    queryFn: () => api.listVaultItems({ query }),
    enabled,
  });
}

/** Wire query for the bindings table. */
export type BindingsQuery = z.input<typeof VaultBindingsQuery>;

/** Bindings page `page` for a query (URL page walked onto keyset cursors). */
export function useVaultBindings(
  query: BindingsQuery,
  page: number,
  pager: CursorPager,
  enabled = true,
) {
  const api = useApi();
  return useQuery({
    queryKey: keys.vault.bindings({ ...query, page }),
    queryFn: () =>
      pager.resolve(JSON.stringify(query), page, (cursor) =>
        api.listVaultBindings({ query: { ...query, ...(cursor !== undefined && { cursor }) } }),
      ),
    placeholderData: (previous) => previous,
    enabled,
  });
}

/** Pending vault confirms (the bridge keeps this list current from `vault.confirm.*`). */
export function useVaultConfirms(enabled = true) {
  const api = useApi();
  return useQuery({
    queryKey: keys.vault.confirms(),
    queryFn: () =>
      api.listVaultConfirm({
        query: {
          status: ['pending'],
          sort: 'created_at',
          dir: 'asc',
          limit: CONFIRM_LIMIT,
          total: true,
        },
      }),
    enabled,
  });
}

/** Unlock with a passphrase or a token per `unlock.mode`; success refreshes everything the lock gated. */
export function useUnlockVault() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: z.input<typeof UnlockVaultRequest>) => api.unlockVault({ body }),
    onSuccess: () => {
      qc.setQueryData(
        keys.vault.status(),
        (s: { unlocked: boolean; checked_at: number } | undefined) =>
          s === undefined ? s : { ...s, unlocked: true },
      );
      void qc.invalidateQueries({ queryKey: keys.vault.all });
    },
  });
}

/** Lock the backend. */
export function useLockVault() {
  const api = useApi();
  const qc = useQueryClient();
  const toast = useToast();
  return useMutation({
    mutationFn: () => api.lockVault(),
    onSuccess: () => void qc.invalidateQueries({ queryKey: keys.vault.all }),
    onError: (error) => toast.fromError(toAppError(error), 'Could not lock the vault'),
  });
}

/** Pull the backend's remote vault; the caller renders the result callout. */
export function useSyncVault() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.syncVault(),
    onSettled: () => void qc.invalidateQueries({ queryKey: keys.vault.all }),
  });
}

/** Group policy input. */
export interface PutPolicyInput {
  readonly groupId: string | null;
  readonly version: number | null;
  readonly body: PutGroupPolicyRequest;
}

/** Save a group policy with `If-Match` when a version exists (waits for the server, spec 04 §11). */
export function usePutGroupPolicy() {
  const api = useApi();
  const qc = useQueryClient();
  const toast = useToast();
  return useMutation({
    mutationFn: ({ groupId, version, body }: PutPolicyInput) =>
      api.putVaultGroupPolicy({
        params: { group_id: groupId ?? UNGROUPED_GROUP_KEY },
        body,
        ...(version !== null && { ifMatch: version }),
      }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: keys.vault.all }),
    onError: (error) => toast.fromError(toAppError(error), 'Could not save the policy'),
  });
}

/** Import an export document (`merge` keeps rows not in the file, `replace` drops them). */
export function useImportVault() {
  const api = useApi();
  const qc = useQueryClient();
  const toast = useToast();
  return useMutation({
    mutationFn: (input: {
      readonly mode: 'merge' | 'replace';
      readonly document: VaultExportDocument;
    }) => api.importVault({ query: { mode: input.mode }, body: input.document }),
    onSuccess: (result) =>
      toast.success({
        title: 'Vault imported',
        description: `${result.imported.bindings} bindings, ${result.imported.policies} policies`,
      }),
    onError: (error) => toast.fromError(toAppError(error), 'Import failed'),
    onSettled: () => void qc.invalidateQueries({ queryKey: keys.vault.all }),
  });
}

/** `system.vault.enabled` from `/system` (the same query the sidebar uses); `undefined` until known, so no `/vault/*` call fires for a daemon without a vault. */
export function useVaultEnabled(): boolean | undefined {
  const api = useApi();
  const system = useQuery({ queryKey: keys.system.status(), queryFn: () => api.getSystem() });
  if (system.data !== undefined) return system.data.vault.enabled;
  // `/system` failed: let the vault endpoints answer for themselves.
  return system.isError ? true : undefined;
}
