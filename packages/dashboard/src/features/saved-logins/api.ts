/** @module features/saved-logins/api — `GET /auth-states`, the client-side filter/sort/page of that whole list, and the delete mutation with its toast (spec 04 §12.7.1, spec 03 §4.6.1) */
import type { AuthStateRow } from '@browserhive/contracts/http';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useApi } from '@/app/providers/AuthProvider.tsx';
import { useToast } from '@/app/providers/ToastProvider.tsx';
import { toAppError } from '@/lib/api/errors.ts';
import { keys } from '@/lib/api/keys.ts';
import type { SavedLoginsSearch } from './search.ts';

/** Kind labels as the operator reads them. */
export const KIND_LABEL: Readonly<Record<AuthStateRow['kind'], string>> = {
  storage: 'Cookies & storage',
  profile: 'Full profile',
};

/** Stable row id: names are unique per owner. */
export function savedLoginId(row: Pick<AuthStateRow, 'owner' | 'name'>): string {
  return `${row.owner}/${row.name}`;
}

/** Every principal's saved logins. */
export function useSavedLogins() {
  const api = useApi();
  return useQuery({ queryKey: keys.authStates.list(), queryFn: () => api.listAuthStates() });
}

const SORTERS: Readonly<Record<string, (a: AuthStateRow, b: AuthStateRow) => number>> = {
  saved: (a, b) => a.saved_at - b.saved_at,
  name: (a, b) => a.name.localeCompare(b.name),
  kind: (a, b) => KIND_LABEL[a.kind].localeCompare(KIND_LABEL[b.kind]),
  owner: (a, b) => a.owner.localeCompare(b.owner),
  size: (a, b) => a.size - b.size,
};

/** Filter (`q` over name, owner and source session; `owner`), sort and page the whole list (pure). */
export function viewOf(
  rows: readonly AuthStateRow[],
  search: Pick<SavedLoginsSearch, 'q' | 'owner' | 'sort' | 'dir' | 'page' | 'ps'>,
): { readonly rows: readonly AuthStateRow[]; readonly total: number } {
  const q = search.q?.toLowerCase();
  const matching = rows.filter(
    (r) =>
      (search.owner === undefined || r.owner === search.owner) &&
      (q === undefined ||
        r.name.toLowerCase().includes(q) ||
        r.owner.toLowerCase().includes(q) ||
        r.source_session_id.toLowerCase().includes(q) ||
        (r.source_session_slug?.toLowerCase().includes(q) ?? false)),
  );
  const compare = SORTERS[search.sort ?? 'saved'] ?? SORTERS['saved'];
  const direction =
    (search.sort === undefined ? 'desc' : (search.dir ?? 'desc')) === 'asc' ? 1 : -1;
  const sorted = [...matching].sort(
    (a, b) => direction * (compare?.(a, b) ?? 0) || savedLoginId(a).localeCompare(savedLoginId(b)),
  );
  const start = (search.page - 1) * search.ps;
  return { rows: sorted.slice(start, start + search.ps), total: matching.length };
}

/** `DELETE /auth-states/{owner}/{name}` with the result toast. */
export function useDeleteSavedLogin() {
  const api = useApi();
  const qc = useQueryClient();
  const toast = useToast();
  return useMutation({
    mutationFn: (row: Pick<AuthStateRow, 'owner' | 'name'>) =>
      api.deleteAuthState({ params: { owner: row.owner, name: row.name } }),
    onSuccess: (_result, row) =>
      toast.success({
        title: `Saved login ${row.name} deleted`,
        description: `Owner: ${row.owner}`,
      }),
    onError: (error) => toast.fromError(toAppError(error), 'Could not delete the saved login'),
    onSettled: () => void qc.invalidateQueries({ queryKey: keys.authStates.all }),
  });
}
