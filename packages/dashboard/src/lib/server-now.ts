/** @module lib/server-now — server-anchored clock: every response `meta.now` / WS `hello`/`tick` updates the offset; `RelativeTime` never trusts the browser clock alone */
import { createContext, useContext, useEffect, useState, useSyncExternalStore } from 'react';
import { browserClock, type Clock } from './clock.ts';

/** Store keeping `serverNow - browserNow`. */
export class ServerClock {
  private offset = 0;
  private anchored = false;
  private readonly listeners = new Set<() => void>();

  constructor(private readonly clock: Clock = browserClock) {}

  /** Record a server timestamp observed "now". */
  anchor(serverNow: number): void {
    const next = serverNow - this.clock();
    if (this.anchored && Math.abs(next - this.offset) < 250) return;
    this.offset = next;
    this.anchored = true;
    for (const listener of this.listeners) listener();
  }

  /** Server-anchored epoch ms. */
  now(): number {
    return this.clock() + this.offset;
  }

  /** `true` once at least one server timestamp was observed. */
  isAnchored(): boolean {
    return this.anchored;
  }

  /** Subscribe to offset changes. */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
}

/** React context for the app's server clock (provided by `QueryProvider`). */
export const ServerClockContext = createContext<ServerClock | null>(null);

/** The app's server clock. */
export function useServerClock(): ServerClock {
  const clock = useContext(ServerClockContext);
  if (clock === null) throw new Error('useServerClock() requires QueryProvider');
  return clock;
}

/** Server-anchored `now` that ticks at `tickMs` (1 Hz default) only while the document is visible. */
export function useServerNow(tickMs = 1000): number {
  const clock = useServerClock();
  const [tick, setTick] = useState(0);
  const anchored = useSyncExternalStore(
    (cb) => clock.subscribe(cb),
    () => clock.isAnchored(),
    () => clock.isAnchored(),
  );
  useEffect(() => {
    let timer: ReturnType<typeof setInterval> | null = null;
    const start = () => {
      if (timer === null) timer = setInterval(() => setTick((t) => t + 1), tickMs);
    };
    const stop = () => {
      if (timer !== null) {
        clearInterval(timer);
        timer = null;
      }
    };
    const onVisibility = () => (document.visibilityState === 'visible' ? start() : stop());
    onVisibility();
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      stop();
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [tickMs]);
  void tick;
  void anchored;
  return clock.now();
}
