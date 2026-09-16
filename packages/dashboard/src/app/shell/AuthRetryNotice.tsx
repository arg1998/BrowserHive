/** @module app/shell/AuthRetryNotice — calm, human wording for a failing session check that is being retried: a slim banner over the shell, or a line under the "Checking your session" spinner */
import { useEffect, useState } from 'react';
import { useAuth } from '@/app/providers/AuthProvider.tsx';
import { type AuthRetry, authRetryCopy } from '@/app/providers/auth-machine.ts';
import { Button } from '@/components/ui/button.tsx';
import { browserClock } from '@/lib/clock.ts';
import { ICONS } from '@/lib/icons.ts';
import { cn } from '@/lib/utils.ts';

/** Whole seconds until the retry is due (never negative; pure, exported for tests). */
export function secondsUntil(retry: AuthRetry, now: number): number {
  return Math.max(0, Math.ceil((retry.at + retry.delayMs - now) / 1000));
}

/** "Retrying in 3s" / "Retrying…" (pure, exported for tests). */
export function retryLabel(seconds: number): string {
  return seconds > 0 ? `Retrying in ${seconds}s` : 'Retrying…';
}

function useSecondsUntil(retry: AuthRetry | null): number {
  const [now, setNow] = useState(() => browserClock());
  useEffect(() => {
    if (retry === null) return undefined;
    setNow(browserClock());
    const timer = setInterval(() => setNow(browserClock()), 1000);
    return () => clearInterval(timer);
  }, [retry]);
  return retry === null ? 0 : secondsUntil(retry, now);
}

/**
 * Banner shown at the top of the shell while the session check keeps failing for a known operator.
 * The app stays usable; only a 401 signs out.
 */
export function AuthRetryBanner() {
  const { state, retry } = useAuth();
  const seconds = useSecondsUntil(state.retry);
  if (state.retry === null) return null;
  const copy = authRetryCopy(state.retry.error);
  const Icon = ICONS.warn;
  return (
    <div
      role="status"
      className="sticky top-(--topbar-height) z-(--z-sticky) flex min-h-10 flex-wrap items-center gap-x-3 gap-y-1 border-b border-warn-border bg-warn-bg px-gutter py-2 text-sm text-foreground backdrop-blur-md"
    >
      <Icon aria-hidden="true" className="size-4 shrink-0 text-warn-text" />
      <p className="min-w-0 flex-1">
        <span className="font-medium">{copy.title}.</span>{' '}
        <span className="text-muted-foreground">
          {copy.body} {retryLabel(seconds)}.
        </span>
      </p>
      <Button type="button" variant="ghost" size="xs" onClick={retry}>
        Retry now
      </Button>
    </div>
  );
}

/** Line under the session-check spinner while probes fail and nobody is known yet. */
export function AuthRetryLine({ className }: { readonly className?: string }) {
  const { state, retry } = useAuth();
  const seconds = useSecondsUntil(state.retry);
  if (state.retry === null) return null;
  const copy = authRetryCopy(state.retry.error);
  return (
    <div className={cn('flex max-w-sm flex-col items-center gap-2 text-center', className)}>
      <p className="text-base font-medium text-foreground">{copy.title}</p>
      <p className="text-sm text-muted-foreground">
        {copy.body} {retryLabel(seconds)}.
      </p>
      <Button type="button" variant="outline" size="sm" onClick={retry}>
        <ICONS.refresh aria-hidden="true" />
        Retry now
      </Button>
    </div>
  );
}
