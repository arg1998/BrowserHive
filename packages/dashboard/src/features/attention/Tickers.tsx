/** @module features/attention/Tickers — the only 1 Hz components on the board: waited time and deadline countdown own their clock subscription, so ticking re-renders a few text nodes instead of whole cards (buttons never re-render under the pointer) */
import type { OperatorRequestRow } from '@browserhive/contracts/http';
import { TonePill } from '@/components/shared/StatusBadge.tsx';
import { Hint } from '@/components/ui/tooltip.tsx';
import { formatAbsolute, formatDuration } from '@/lib/format/time.ts';
import { useServerNow } from '@/lib/server-now.ts';
import { cn } from '@/lib/utils.ts';
import { deadlineCountdown, waitedMs } from './countdown.ts';

/** "Waiting 4m 12s" for a pending request. */
export function WaitingFor({
  row,
  className,
}: {
  readonly row: Pick<OperatorRequestRow, 'created_at' | 'waited_ms' | 'status'>;
  readonly className?: string;
}) {
  const now = useServerNow();
  return (
    <Hint label={`Blocked since ${formatAbsolute(row.created_at)}`}>
      <span className={cn('tabular-nums', className)}>
        Waiting {formatDuration(waitedMs(row, now))}
      </span>
    </Hint>
  );
}

/** Deadline pill ("29m 12s left"); renders nothing without a deadline. */
export function DeadlinePill({ deadlineAt }: { readonly deadlineAt: number | null }) {
  const now = useServerNow();
  const countdown = deadlineCountdown(deadlineAt, now);
  if (countdown === null || deadlineAt === null) return null;
  return (
    <Hint
      label={
        countdown.expired
          ? 'The deadline passed; the agent call is timing out'
          : `The agent gives up at ${formatAbsolute(deadlineAt)}`
      }
    >
      <span className="inline-flex rounded-full">
        <TonePill
          entry={{ label: countdown.label, tone: countdown.tone, icon: 'clock' }}
          pulse={countdown.tone === 'danger'}
          className="tabular-nums"
        />
      </span>
    </Hint>
  );
}
