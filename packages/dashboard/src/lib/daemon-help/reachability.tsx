/** @module lib/daemon-help/reachability — `DaemonReachabilityProvider` (04 §18.7), mounted once by `AppShell` inside `SocketProvider`: owns the one reachability watcher (`watcher.ts`) that `HealthPill` and `DaemonUnreachableBanner` both read, so there is never a second `/health` poller. */
import { useQueryClient } from '@tanstack/react-query';
import {
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useState,
  useSyncExternalStore,
} from 'react';
import type { Clock, Timers } from '@/lib/clock.ts';
import type { OfflineReason, SocketStatus } from '@/lib/ws/store.ts';
import type { ProbeFetch } from './probe.ts';
import { DaemonReachability, HIDDEN_SNAPSHOT, type ReachabilitySnapshot } from './watcher.ts';

const ReachabilityContext = createContext<DaemonReachability | null>(null);

/** Props; the probe's fetch and the timers are injectable (the page harness passes its own). */
export interface DaemonReachabilityProviderProps {
  readonly children: ReactNode;
  /** The socket store's state (`useSocketState()`); passed in so `lib/` does not reach into `app/`. */
  readonly socket: { readonly status: SocketStatus; readonly reason: OfflineReason | null };
  readonly fetch?: ProbeFetch;
  readonly timers?: Timers;
  readonly clock?: Clock;
}

/** Mounted once by `AppShell` (inside `SocketProvider`). */
export function DaemonReachabilityProvider({
  children,
  socket,
  fetch,
  timers,
  clock,
}: DaemonReachabilityProviderProps) {
  const client = useQueryClient();
  const [watcher] = useState(
    () =>
      new DaemonReachability({
        client,
        ...(fetch !== undefined && { fetch }),
        ...(timers !== undefined && { timers }),
        ...(clock !== undefined && { clock }),
      }),
  );
  useEffect(() => {
    watcher.start();
    return () => watcher.stop();
  }, [watcher]);
  useEffect(() => {
    watcher.socketChanged(socket.status, socket.reason);
  }, [watcher, socket.status, socket.reason]);
  return <ReachabilityContext.Provider value={watcher}>{children}</ReachabilityContext.Provider>;
}

const noSubscribe = () => () => undefined;
const hiddenSnapshot = () => HIDDEN_SNAPSHOT;

/** What the shell shows, plus `lastAnswerAt()`; outside the provider: healthy, no banner. */
export function useDaemonReachability(): ReachabilitySnapshot & {
  readonly lastAnswerAt: () => number | null;
} {
  const watcher = useContext(ReachabilityContext);
  const snapshot = useSyncExternalStore(
    watcher?.subscribe ?? noSubscribe,
    watcher?.getSnapshot ?? hiddenSnapshot,
  );
  return { ...snapshot, lastAnswerAt: () => watcher?.lastAnswerAt() ?? null };
}
