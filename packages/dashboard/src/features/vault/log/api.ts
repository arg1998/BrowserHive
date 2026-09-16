/** @module features/vault/log/api — `GET /vault/log` page for the URL state (keyset cursors behind URL pages) and the live feed wiring */

import { SessionId } from '@browserhive/contracts/ids';
import { sessionTopic } from '@browserhive/contracts/ws';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback } from 'react';
import { useApi } from '@/app/providers/AuthProvider.tsx';
import { useTopic } from '@/app/providers/SocketProvider.tsx';
import type { CursorPager } from '@/components/shared/use-cursor-pages.ts';
import { isAppError } from '@/lib/api/errors.ts';
import { keys } from '@/lib/api/keys.ts';
import { useServerClock } from '@/lib/server-now.ts';
import { logKeyParams, logWireQuery, type VaultLogSearch } from './search.ts';

/** Access log page. */
export function useVaultLog(search: VaultLogSearch, pager: CursorPager, enabled = true) {
  const api = useApi();
  const clock = useServerClock();
  return useQuery({
    queryKey: keys.vault.log(logKeyParams(search)),
    queryFn: () => {
      const query = logWireQuery(search, Math.floor(clock.now() / 60_000) * 60_000);
      const chainKey = JSON.stringify({ ...query, since: undefined, until: undefined });
      return pager.resolve(chainKey, search.page, (cursor) =>
        api.listVaultLog({ query: { ...query, ...(cursor !== undefined && { cursor }) } }),
      );
    },
    placeholderData: (previous) => previous,
    enabled,
    retry: (count, error) =>
      !(isAppError(error) && error.code === 'VAULT_NOT_CONFIGURED') && count < 2,
  });
}

/**
 * Live rows: an unfiltered log subscribes to the fleet-wide `vault.access` topic; a session-filtered log
 * subscribes to that `session:<id>` topic (the bridge patches the cache); resolved confirms refresh the log.
 */
export function useVaultLogFeed(sessionId: string | undefined, enabled = true): void {
  const qc = useQueryClient();
  const onConfirm = useCallback(
    (event: { readonly type: string }) => {
      if (event.type === 'vault.confirm.resolved')
        void qc.invalidateQueries({ queryKey: keys.vault.logs() });
    },
    [qc],
  );
  const parsed = SessionId.safeParse(sessionId);
  // Filtered to one session → that session's topic; otherwise the fleet-wide audit feed.
  useTopic(enabled ? (parsed.success ? sessionTopic(parsed.data) : 'vault.access') : null);
  useTopic(enabled ? 'vault.confirm' : null, onConfirm);
}
