/** @module features/auth/use-retry-countdown — seconds left until a 429 `retry_after_ms` elapses */
import { useEffect, useState } from 'react';

/** Countdown in whole seconds; `0` when nothing is pending. */
export function useRetryCountdown(retryAfterMs: number | null): number {
  const [left, setLeft] = useState(0);
  useEffect(() => {
    if (retryAfterMs === null || retryAfterMs <= 0) {
      setLeft(0);
      return undefined;
    }
    const end = performance.now() + retryAfterMs;
    const tick = () => setLeft(Math.max(0, Math.ceil((end - performance.now()) / 1000)));
    tick();
    const timer = setInterval(tick, 250);
    return () => clearInterval(timer);
  }, [retryAfterMs]);
  return left;
}
