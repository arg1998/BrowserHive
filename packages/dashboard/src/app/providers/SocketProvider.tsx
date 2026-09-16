/** @module app/providers/SocketProvider — mounts the socket store while auth is `ready`; wires bridge, resync, toasts; `useSocket()`, `useSocketState()`, `useTopic()` (spec 04 §4.2) */
import { useQueryClient } from '@tanstack/react-query';
import {
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import { useServerClock } from '@/lib/server-now.ts';
import { applyFeedEvent } from '@/lib/ws/bridge.ts';
import {
  type FeedHandler,
  type SocketState,
  SocketStore,
  type SocketStoreOptions,
  socketUrl,
} from '@/lib/ws/store.ts';
import { useAuth } from './AuthProvider.tsx';
import { useToast } from './ToastProvider.tsx';

const SocketContext = createContext<SocketStore | null>(null);

/** State shown before a store exists. */
const IDLE_STATE: SocketState = {
  status: 'idle',
  reason: null,
  protocolMismatch: false,
  attempt: 0,
  epoch: null,
  serverVersion: null,
};

/** Props; `createStore` is injectable for tests. */
export interface SocketProviderProps {
  readonly children: ReactNode;
  readonly createStore?: (options: SocketStoreOptions) => SocketStore;
}

/** Owns one store per `ready` auth session; leaving `ready` disposes it. */
export function SocketProvider({ children, createStore }: SocketProviderProps) {
  const { state: auth, dispatch } = useAuth();
  const queryClient = useQueryClient();
  const toast = useToast();
  const serverClock = useServerClock();
  const [store, setStore] = useState<SocketStore | null>(null);
  const toastRef = useRef(toast);
  toastRef.current = toast;
  const ready = auth.status === 'ready';

  useEffect(() => {
    if (!ready) return undefined;
    const options: SocketStoreOptions = {
      url: socketUrl(window.location),
      hooks: {
        onEvent: (event, meta) => {
          applyFeedEvent(queryClient, event, meta.topic);
        },
        onReconnected: () => {
          void queryClient.invalidateQueries();
        },
        onResync: (_reason, topic) => {
          if (topic === undefined) void queryClient.invalidateQueries();
          else void queryClient.invalidateQueries({ queryKey: [topic.split(':')[0] ?? topic] });
        },
        onUnauthorized: () => {
          queryClient.clear();
          dispatch({ type: 'unauthorized' });
        },
        onPasswordChangeRequired: () => dispatch({ type: 'password_change_required' }),
        onProtocolMismatch: () => {
          toastRef.current.error({
            id: 'ws-protocol',
            title: 'Dashboard is out of date',
            description: 'The daemon speaks a newer realtime protocol. Reload to update.',
            action: { label: 'Reload', onClick: () => window.location.reload() },
          });
        },
        onDrop: (command) => {
          toastRef.current.warning({
            id: 'ws-drop',
            title: 'Not connected',
            description: `${command.type} was not sent: the realtime socket is offline.`,
          });
        },
        onServerNow: (now) => serverClock.anchor(now),
      },
    };
    const next = createStore !== undefined ? createStore(options) : new SocketStore(options);
    next.connect();
    setStore(next);
    return () => {
      next.dispose();
      setStore(null);
    };
  }, [ready, queryClient, dispatch, serverClock, createStore]);

  return <SocketContext.Provider value={store}>{children}</SocketContext.Provider>;
}

/** The store, or `null` before auth is ready. */
export function useSocket(): SocketStore | null {
  return useContext(SocketContext);
}

/** Observable socket state (health pill). */
export function useSocketState(): SocketState {
  const store = useContext(SocketContext);
  return useSyncExternalStore(
    (cb) => (store === null ? () => undefined : store.watch(cb)),
    () => (store === null ? IDLE_STATE : store.getState()),
    () => IDLE_STATE,
  );
}

/** Subscribe to a feed topic while mounted. `handler` may be omitted when the bridge is all that is needed. */
export function useTopic(topic: string | null, handler?: FeedHandler): void {
  const store = useContext(SocketContext);
  const handlerRef = useRef(handler);
  handlerRef.current = handler;
  useEffect(() => {
    if (store === null || topic === null) return undefined;
    return store.subscribe(topic, (event, meta) => handlerRef.current?.(event, meta));
  }, [store, topic]);
}
