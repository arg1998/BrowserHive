/** @module app/providers/AuthProvider — owns the API client (interceptors) and the auth machine, caches the last known principal so transient probe failures keep the shell; `useAuth()`, `useApi()` (spec 04 §4.1) */
import { AuthPrincipal } from '@browserhive/contracts/http';
import { useQueryClient } from '@tanstack/react-query';
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from 'react';
import { type ApiClient, createApiClient } from '@/lib/api/client.ts';
import { type AppError, isAppError, toAppError } from '@/lib/api/errors.ts';
import type { FetchLike } from '@/lib/api/http.ts';
import { buildId, type ClientErrorSink, createClientErrorSink } from '@/lib/client-errors.ts';
import { browserClock } from '@/lib/clock.ts';
import { useServerClock } from '@/lib/server-now.ts';
import { readStorageJson, removeStorage, writeStorageJson } from '@/lib/storage.ts';
import {
  AUTH_PROBE_TIMEOUT_MS,
  type AuthEvent,
  type AuthState,
  initialAuthState,
  probeRetryDelayMs,
  reduceAuth,
} from './auth-machine.ts';

/**
 * Last known principal, so a transient probe failure on reload keeps the shell instead of an error
 * card. Not a credential: the cookie still decides every request, and any 401 signs out.
 */
export const PRINCIPAL_CACHE_KEY = 'bh.auth.principal';

function readCachedPrincipal(): AuthPrincipal | null {
  return readStorageJson(PRINCIPAL_CACHE_KEY, (raw) => {
    const parsed = AuthPrincipal.safeParse(raw);
    return parsed.success ? parsed.data : null;
  });
}

/** Paths where an unknown visitor is expected: no probe (and no 401) until they sign in. */
function isSignInPath(): boolean {
  return globalThis.location?.pathname === '/login';
}

/** What `useAuth()` returns. */
export interface AuthApi {
  readonly state: AuthState;
  readonly login: (password: string) => Promise<void>;
  readonly changePassword: (currentPassword: string, newPassword: string) => Promise<void>;
  readonly logout: () => Promise<void>;
  /** Re-run the `/auth/me` probe now (Retry button). */
  readonly retry: () => void;
  readonly dispatch: (event: AuthEvent) => void;
}

const AuthContext = createContext<AuthApi | null>(null);
const ApiContext = createContext<ApiClient | null>(null);
const ClientErrorContext = createContext<ClientErrorSink | null>(null);

/** Props; `fetch` is injectable for tests (the interceptors stay attached). */
export interface AuthProviderProps {
  readonly children: ReactNode;
  readonly fetch?: FetchLike;
  readonly probeTimeoutMs?: number;
}

/** Classify a probe failure; `attempt` is the number of failures before this one. */
function classify(error: AppError, attempt: number): AuthEvent {
  if (error.status === 401) return { type: 'probe.unauthorized' };
  return {
    type: 'probe.failed',
    error,
    delayMs: probeRetryDelayMs(error, attempt + 1),
    at: browserClock(),
  };
}

/** Owns the auth machine. Must sit inside `QueryProvider`. */
export function AuthProvider({ children, fetch: fetchImpl, probeTimeoutMs }: AuthProviderProps) {
  const queryClient = useQueryClient();
  const serverClock = useServerClock();
  const [state, dispatch] = useReducer(reduceAuth, undefined, () =>
    initialAuthState(readCachedPrincipal(), { skipProbe: isSignInPath() }),
  );
  const attemptRef = useRef(state.attempt);
  attemptRef.current = state.attempt;
  const statusRef = useRef(state.status);
  statusRef.current = state.status;

  // Interceptors reach the reducer through a ref so the client is created once.
  const onUnauthorized = useCallback(() => {
    if (statusRef.current === 'login') return;
    queryClient.clear();
    dispatch({ type: 'unauthorized' });
  }, [queryClient]);
  const onPasswordChangeRequired = useCallback(() => {
    dispatch({ type: 'password_change_required' });
  }, []);
  const signals = useRef({ onUnauthorized, onPasswordChangeRequired });
  signals.current = { onUnauthorized, onPasswordChangeRequired };

  const sinkRef = useRef<ClientErrorSink | null>(null);
  const [client] = useState<ApiClient>(() =>
    createApiClient({
      ...(fetchImpl !== undefined && { fetch: fetchImpl }),
      strict: import.meta.env.DEV,
      signals: {
        onUnauthorized: () => signals.current.onUnauthorized(),
        onPasswordChangeRequired: () => signals.current.onPasswordChangeRequired(),
      },
      report: (mismatch) => {
        sinkRef.current?.report({
          message: `wire mismatch in ${mismatch.operationId}`,
          stack: JSON.stringify(mismatch.issues).slice(0, 4000),
          route: window.location.pathname,
        });
      },
    }),
  );
  const [sink] = useState(() =>
    createClientErrorSink({
      post: async (payload) => {
        await client.reportClientError({ body: payload });
      },
      build: buildId(),
      userAgent: navigator.userAgent,
      clock: browserClock,
    }),
  );
  sinkRef.current = sink;

  const probe = useCallback(async () => {
    dispatch({ type: 'probe.start' });
    try {
      const me = await client.getMe({ timeoutMs: probeTimeoutMs ?? AUTH_PROBE_TIMEOUT_MS });
      if (me.session !== undefined) serverClock.anchor(me.session.last_seen_at);
      dispatch({ type: 'probe.ok', me });
    } catch (error) {
      dispatch(classify(toAppError(error), attemptRef.current));
    }
  }, [client, probeTimeoutMs, serverClock]);

  // Probe on mount, after sign-in and whenever a retry is due.
  useEffect(() => {
    if (state.pending) void probe();
  }, [state.pending, probe]);

  // Failed probes retry with backoff (honouring retry-after) while the last known state stays up.
  useEffect(() => {
    if (state.retry === null || state.pending) return undefined;
    const timer = setTimeout(() => dispatch({ type: 'retry' }), state.retry.delayMs);
    return () => clearTimeout(timer);
  }, [state.retry, state.pending]);

  // Remember who is signed in; forget on sign-out.
  useEffect(() => {
    if (state.principal === null) removeStorage(PRINCIPAL_CACHE_KEY);
    else writeStorageJson(PRINCIPAL_CACHE_KEY, state.principal);
  }, [state.principal]);

  const value = useMemo<AuthApi>(
    () => ({
      state,
      dispatch,
      login: async (password) => {
        const result = await client.login({ body: { password } });
        queryClient.clear();
        dispatch({ type: 'logged_in', mustChange: result.must_change_password });
      },
      changePassword: async (currentPassword, newPassword) => {
        await client.changePassword({
          body: { current_password: currentPassword, new_password: newPassword },
        });
        queryClient.clear();
        dispatch({ type: 'password_changed' });
      },
      logout: async () => {
        try {
          await client.logout();
        } catch (error) {
          if (!isAppError(error) || error.status !== 401) throw error;
        } finally {
          queryClient.clear();
          dispatch({ type: 'logged_out' });
        }
      },
      retry: () => dispatch({ type: 'retry' }),
    }),
    [state, client, queryClient],
  );

  return (
    <ApiContext.Provider value={client}>
      <ClientErrorContext.Provider value={sink}>
        <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
      </ClientErrorContext.Provider>
    </ApiContext.Provider>
  );
}

/** The auth machine. */
export function useAuth(): AuthApi {
  const value = useContext(AuthContext);
  if (value === null) throw new Error('useAuth() requires AuthProvider');
  return value;
}

/** The typed API client. */
export function useApi(): ApiClient {
  const value = useContext(ApiContext);
  if (value === null) throw new Error('useApi() requires AuthProvider');
  return value;
}

/** The client-error sink (boundaries report through it). */
export function useClientErrorSink(): ClientErrorSink {
  const value = useContext(ClientErrorContext);
  if (value === null) throw new Error('useClientErrorSink() requires AuthProvider');
  return value;
}
