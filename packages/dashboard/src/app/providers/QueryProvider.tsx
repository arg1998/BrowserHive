/** @module app/providers/QueryProvider — one QueryClient (FRESHNESS_MS, retries except 4xx) plus the server-anchored clock (spec 04 §4.5) */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { type ReactNode, useState } from 'react';
import { isAppError } from '@/lib/api/errors.ts';
import { ServerClock, ServerClockContext } from '@/lib/server-now.ts';

/** The only freshness value in the app (spec 04 §4.5). */
export const FRESHNESS_MS = 15_000;

/** Retry policy: twice with a short backoff; never on 4xx, client aborts/bugs or errors the daemon marks `never`. */
export function shouldRetry(failureCount: number, error: unknown): boolean {
  if (failureCount >= 2) return false;
  if (isAppError(error)) {
    if (error.retryable === 'never') return false;
    if (error.code === 'ABORTED' || error.code === 'MALFORMED_RESPONSE') return false;
    if (error.status >= 400 && error.status < 500) return false;
  }
  return true;
}

/** Build the app's QueryClient. Exported so tests build an identical one. */
export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: FRESHNESS_MS,
        refetchOnWindowFocus: true,
        // Reconnect refetches are driven by the socket store (`onReconnected`), not the browser event.
        refetchOnReconnect: false,
        retry: shouldRetry,
        retryDelay: (attempt) => Math.min(750 * 2 ** attempt, 4000),
      },
      mutations: { retry: false },
    },
  });
}

/** Props; `client`/`clock` are injectable for tests. */
export interface QueryProviderProps {
  readonly children: ReactNode;
  readonly client?: QueryClient;
  readonly clock?: ServerClock;
}

/** Provides the QueryClient and the server clock. */
export function QueryProvider({ children, client, clock }: QueryProviderProps) {
  const [queryClient] = useState(() => client ?? createQueryClient());
  const [serverClock] = useState(() => clock ?? new ServerClock());
  return (
    <QueryClientProvider client={queryClient}>
      <ServerClockContext.Provider value={serverClock}>{children}</ServerClockContext.Provider>
    </QueryClientProvider>
  );
}
