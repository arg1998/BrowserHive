/** @module features/vault/confirm/ConfirmRow — one held `vault_fill`: entry chip, requesting session, target URL, tool, deadline, Approve / Deny with inline reason (Enter = deny, Esc = cancel) (spec 04 §12.7, D-15) */
import type { OperatorRequestRow } from '@browserhive/contracts/http';
import { useId, useState } from 'react';
import { VaultChip } from '@/components/shared/Chip.tsx';
import { TonePill } from '@/components/shared/StatusBadge.tsx';
import { SessionRef } from '@/components/shared/session-ref.tsx';
import { UrlCell } from '@/components/shared/url-cell.tsx';
import { Button } from '@/components/ui/button.tsx';
import { Input } from '@/components/ui/input.tsx';
import { deadlineCountdown, waitedLabel } from '@/features/attention/countdown.ts';
import { ICONS } from '@/lib/icons.ts';

/** Props. */
export interface ConfirmRowProps {
  readonly item: OperatorRequestRow;
  readonly now: number;
  readonly busy?: boolean;
  readonly onApprove: () => void;
  readonly onDeny: (reason: string) => void;
}

/** Approve / Deny controls; Deny reveals an inline reason box (the reason is audit-only). */
export function ConfirmDenyControls({
  busy = false,
  onApprove,
  onDeny,
}: Pick<ConfirmRowProps, 'busy' | 'onApprove' | 'onDeny'>) {
  const [denying, setDenying] = useState(false);
  const [reason, setReason] = useState('');
  const reasonId = useId();
  const Check = ICONS.check;
  const Close = ICONS.close;
  const cancel = () => {
    setDenying(false);
    setReason('');
  };
  if (denying) {
    return (
      <form
        className="flex flex-wrap items-center gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          onDeny(reason.trim());
        }}
      >
        <label htmlFor={reasonId} className="sr-only">
          Reason for denying
        </label>
        <Input
          id={reasonId}
          autoFocus
          className="min-w-48 font-mono"
          placeholder="optional reason for denying…"
          maxLength={500}
          value={reason}
          onChange={(event) => setReason(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Escape') cancel();
          }}
        />
        <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={cancel}>
          Cancel
        </Button>
        <Button type="submit" variant="destructive" size="sm" disabled={busy}>
          <Close aria-hidden="true" />
          Deny
        </Button>
      </form>
    );
  }
  return (
    <div className="flex items-center gap-2">
      <Button
        type="button"
        variant="ghost"
        size="sm"
        disabled={busy}
        onClick={() => setDenying(true)}
      >
        <Close aria-hidden="true" />
        Deny
      </Button>
      <Button type="button" size="sm" disabled={busy} onClick={onApprove}>
        <Check aria-hidden="true" />
        Approve
      </Button>
    </div>
  );
}

/** Confirm row. */
export function ConfirmRow({ item, now, busy, onApprove, onDeny }: ConfirmRowProps) {
  const countdown = deadlineCountdown(item.deadline_at, now);
  return (
    <li
      className="flex flex-col gap-3 rounded-xl border border-vault-border bg-card p-4 shadow-xs dark:shadow-none"
      aria-label={`Fill of ${item.entry_name ?? item.reason}`}
    >
      <div className="flex flex-wrap items-center gap-2">
        <VaultChip handle={item.entry_name ?? item.reason} />
        <span className="text-sm text-muted-foreground">requested by</span>
        <SessionRef id={item.session_id} slug={item.session_slug} />
        <span className="ml-auto font-mono text-sm tabular-nums text-muted-foreground">
          {waitedLabel(item, now)}
        </span>
        {countdown !== null ? (
          <TonePill
            entry={{ label: countdown.label, tone: countdown.tone }}
            pulse={countdown.tone === 'danger'}
          />
        ) : null}
      </div>
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
        <dt className="text-muted-foreground">target</dt>
        <dd className="min-w-0">
          <UrlCell url={item.page_url} />
        </dd>
        <dt className="text-muted-foreground">tool</dt>
        <dd className="font-mono text-sm">{item.tool ?? '—'}</dd>
        {item.reason !== '' && item.reason !== item.entry_name ? (
          <>
            <dt className="text-muted-foreground">reason</dt>
            <dd>{item.reason}</dd>
          </>
        ) : null}
      </dl>
      <div className="flex flex-wrap items-center justify-end gap-2">
        <ConfirmDenyControls
          {...(busy !== undefined && { busy })}
          onApprove={onApprove}
          onDeny={onDeny}
        />
      </div>
    </li>
  );
}
