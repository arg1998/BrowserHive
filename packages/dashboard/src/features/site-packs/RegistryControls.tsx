/** @module features/site-packs/RegistryControls — the registry client's header controls on `/site-packs` (spec 13 §10.4, §11.4): the last check line ("Checked 3m ago · up to date", "· 2 updates", "· failed", the next check), **Check now** (disabled with its reason while no check may run, a 429 waits out its retry time) and **Download all** (what it hides behind its hint, disabled without a fresh index); `WithReason` puts a disabled control's reason on hover and focus */
import type { SitePackRegistryStatus } from '@browserhive/contracts/http';
import { type ReactElement, useEffect, useState } from 'react';
import { useToast } from '@/app/providers/ToastProvider.tsx';
import { RelativeTime } from '@/components/shared/RelativeTime.tsx';
import { TONE_CLASSES } from '@/components/shared/tones.ts';
import { Button } from '@/components/ui/button.tsx';
import { Spinner } from '@/components/ui/spinner.tsx';
import { Hint } from '@/components/ui/tooltip.tsx';
import { toAppError } from '@/lib/api/errors.ts';
import { browserClock } from '@/lib/clock.ts';
import { ICONS } from '@/lib/icons.ts';
import { cn } from '@/lib/utils.ts';
import { useCheckSitePacks, useDownloadAllSitePacks } from './api.ts';
import {
  checkLine,
  checkNowBlocked,
  checkToast,
  DOWNLOAD_ALL_INFO,
  downloadAllToast,
  downloadBlocked,
} from './registry-model.ts';

/** A control with a tooltip: the reason it is disabled, else its hint; the wrapper keeps a disabled control focusable. */
export function WithReason({
  reason,
  hint,
  children,
}: {
  readonly reason: string | null;
  readonly hint?: string;
  readonly children: ReactElement;
}) {
  if (reason === null) return hint === undefined ? children : <Hint label={hint}>{children}</Hint>;
  return (
    <Hint label={reason}>
      {/* biome-ignore lint/a11y/noNoninteractiveTabindex: the wrapper carries the disabled control's reason */}
      <span tabIndex={0} className="inline-flex rounded-md focus-ring">
        {children}
      </span>
    </Hint>
  );
}

/** The header's check line, or nothing with site packs off. */
export function CheckMeta({
  status,
  pendingCount,
  onlineUnfollowed = 0,
}: {
  readonly status: SitePackRegistryStatus;
  readonly pendingCount: number;
  readonly onlineUnfollowed?: number;
}) {
  const line = checkLine(status, pendingCount, onlineUnfollowed);
  if (line === null) return null;
  return (
    <span
      className="inline-flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5 text-sm text-muted-foreground"
      data-check-outcome={line.outcome}
    >
      <span
        aria-hidden="true"
        className={cn('size-2 shrink-0 rounded-full', TONE_CLASSES[line.tone].dot)}
      />
      {line.at !== null ? (
        <span>
          Checked <RelativeTime at={line.at} className="min-w-0 text-sm" />
        </span>
      ) : null}
      {line.at !== null ? <span aria-hidden="true">·</span> : null}
      <span
        className={cn(
          line.tone === 'danger' || line.tone === 'warn'
            ? TONE_CLASSES[line.tone].text
            : 'text-foreground',
          'font-medium',
        )}
      >
        {line.outcome}
      </span>
      {status.check_off === null && status.next_check_at !== null ? (
        <>
          <span aria-hidden="true">·</span>
          <span>
            Next check <RelativeTime at={status.next_check_at} className="min-w-0 text-sm" />
          </span>
        </>
      ) : null}
    </span>
  );
}

/** Seconds left until `until`, ticking once a second; `0` once past (or without a deadline). */
function useSecondsLeft(until: number | null): number {
  const [now, setNow] = useState(() => browserClock());
  useEffect(() => {
    if (until === null) return;
    const id = setInterval(() => setNow(browserClock()), 1000);
    return () => clearInterval(id);
  }, [until]);
  return until === null ? 0 : Math.max(0, Math.ceil((until - now) / 1000));
}

/** **Check now** (`POST /site-packs/check`). */
export function CheckNowButton({ status }: { readonly status: SitePackRegistryStatus }) {
  const check = useCheckSitePacks();
  const toast = useToast();
  const [retryAt, setRetryAt] = useState<number | null>(null);
  const wait = useSecondsLeft(retryAt);
  const blocked =
    checkNowBlocked(status) ?? (wait > 0 ? `Checked too often: try again in ${wait} s.` : null);
  const onCheck = () =>
    check.mutate(undefined, {
      onSuccess: (response) => {
        const t = checkToast(response);
        const input = {
          title: t.title,
          ...(t.description !== undefined && { description: t.description }),
        };
        if (t.kind === 'error') toast.error(input);
        else if (t.kind === 'info') toast.info(input);
        else toast.success(input);
      },
      onError: (error: unknown) => {
        const e = toAppError(error);
        if (e.status === 429) {
          const ms = e.retryAfterMs ?? 60_000;
          setRetryAt(browserClock() + ms);
          toast.warning({
            title: 'Checked too often',
            description: `Up to 6 checks a minute: try again in ${Math.ceil(ms / 1000)} s.`,
          });
          return;
        }
        toast.fromError(e);
      },
    });
  return (
    <WithReason reason={blocked}>
      <Button type="button" disabled={blocked !== null || check.isPending} onClick={onCheck}>
        {check.isPending ? <Spinner /> : <ICONS.refresh aria-hidden="true" />}
        Check now
      </Button>
    </WithReason>
  );
}

/** **Download all** (`POST /site-packs/download-all`). */
export function DownloadAllButton({ status }: { readonly status: SitePackRegistryStatus }) {
  const all = useDownloadAllSitePacks();
  const toast = useToast();
  const blocked = downloadBlocked(status);
  const onDownload = () =>
    all.mutate(undefined, {
      onSuccess: (response) => {
        const t = downloadAllToast(response);
        if (t.kind === 'warning') toast.warning({ title: t.title, description: t.description });
        else toast.success({ title: t.title, description: t.description });
      },
    });
  return (
    <WithReason reason={blocked} hint={DOWNLOAD_ALL_INFO}>
      <Button
        type="button"
        variant="outline"
        disabled={blocked !== null || all.isPending}
        onClick={onDownload}
      >
        {all.isPending ? <Spinner /> : <ICONS.download aria-hidden="true" />}
        Download all
      </Button>
    </WithReason>
  );
}
