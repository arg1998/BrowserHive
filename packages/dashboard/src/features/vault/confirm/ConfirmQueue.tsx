/** @module features/vault/confirm/ConfirmQueue — the confirm-release queue: "{n} blocked", Approve all / Reject all (confirm), rows with optimistic approve/deny (spec 04 §12.7) */
import type { OperatorRequestRow } from '@browserhive/contracts/http';
import { useConfirm } from '@/app/providers/ConfirmProvider.tsx';
import { EmptyState } from '@/components/shared/EmptyState.tsx';
import { Section } from '@/components/shared/Section.tsx';
import { TonePill } from '@/components/shared/StatusBadge.tsx';
import { Button } from '@/components/ui/button.tsx';
import { useServerNow } from '@/lib/server-now.ts';
import { ConfirmRow } from './ConfirmRow.tsx';
import { useBulkConfirm, useResolveConfirm } from './use-resolve-confirm.ts';

/** Props. */
export interface ConfirmQueueProps {
  readonly items: readonly OperatorRequestRow[];
  /** Section title; the attention board and the vault page label it differently. */
  readonly title?: string;
  readonly hideWhenEmpty?: boolean;
}

/** Confirm queue. */
export function ConfirmQueue({
  items,
  title = 'Confirm-release queue',
  hideWhenEmpty = false,
}: ConfirmQueueProps) {
  const now = useServerNow();
  const confirm = useConfirm();
  const resolve = useResolveConfirm();
  const bulk = useBulkConfirm();
  if (hideWhenEmpty && items.length === 0) return null;
  const ids = items.map((item) => item.request_id);
  const runBulk = async (action: 'approve' | 'deny') => {
    const ok = await confirm(
      action === 'approve'
        ? {
            title: `Approve all ${items.length} fills?`,
            description: 'Every held vault_fill releases its credential to the requesting session.',
            confirmLabel: 'Approve all',
          }
        : {
            title: `Deny all ${items.length} fills?`,
            description: `Deny every held vault_fill — all ${items.length} waiting agents are blocked.`,
            confirmLabel: 'Deny all',
            danger: true,
          },
    );
    if (ok) bulk.mutate({ action, requestIds: ids });
  };
  return (
    <Section
      title={title}
      count={items.length}
      info={
        <>
          Entries with <code>dashboard_confirm</code> hold every fill until you approve it here. The
          agent's <code>vault_fill</code> call waits; a denial is recorded in the vault log with
          your reason.
        </>
      }
      infoDocs="vaultConfirmations"
      actions={
        <>
          <TonePill
            entry={{ label: `${items.length} blocked`, tone: 'vault' }}
            pulse={items.length > 0}
          />
          {items.length > 1 ? (
            <>
              <Button
                type="button"
                size="sm"
                disabled={bulk.isPending}
                onClick={() => void runBulk('approve')}
              >
                Approve all
              </Button>
              <Button
                type="button"
                variant="destructive"
                size="sm"
                disabled={bulk.isPending}
                onClick={() => void runBulk('deny')}
              >
                Reject all
              </Button>
            </>
          ) : null}
        </>
      }
    >
      {items.length === 0 ? (
        <EmptyState
          kind="zero-data"
          icon="vault"
          title="No fills waiting"
          description="A vault_fill with dashboard_confirm on is held here until you approve or deny it."
        />
      ) : (
        <>
          <p className="text-sm text-muted-foreground">
            A <span className="font-mono">vault_fill</span> is held pending your decision — each
            waits here until you approve or deny.
          </p>
          <ul className="flex flex-col gap-2">
            {items.map((item) => (
              <ConfirmRow
                key={item.request_id}
                item={item}
                now={now}
                busy={bulk.isPending}
                onApprove={() =>
                  resolve.mutate({ requestId: item.request_id, decision: 'approve' })
                }
                onDeny={(reason) =>
                  resolve.mutate({ requestId: item.request_id, decision: 'deny', reason })
                }
              />
            ))}
          </ul>
        </>
      )}
    </Section>
  );
}
