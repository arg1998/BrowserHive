/** @module features/attention/LiveBoard — the open queue: "Open requests" section (bulk actions when more than one agent request; a site pack's site checks and write approvals are never settled in bulk; the open count is shown once, in the page header), memoised attention cards with stable callbacks and per-request drafts, the vault confirm queue when the vault is on (spec 04 §12.4, §11) */
import type { OperatorRequestRow } from '@browserhive/contracts/http';
import { useCallback, useMemo, useRef, useState } from 'react';
import { useConfirm } from '@/app/providers/ConfirmProvider.tsx';
import { EmptyState } from '@/components/shared/EmptyState.tsx';
import { Section } from '@/components/shared/Section.tsx';
import { Button } from '@/components/ui/button.tsx';
import { ConfirmQueue } from '@/features/vault/confirm/ConfirmQueue.tsx';
import { AttentionCard, type Decision } from './AttentionCard.tsx';
import { useBulkAttention, useResolveAttention } from './api.ts';
import { interceptOf } from './SecurityIntercept.tsx';

/**
 * Requests a bulk action may settle: never a site pack's `security_intercept` (spec 13 §9.3: each
 * write approval and site check is decided on its own card, where its method, address and guard
 * show; the server refuses them in bulk too).
 */
export function bulkable(rows: readonly OperatorRequestRow[]): readonly OperatorRequestRow[] {
  return rows.filter((row) => row.kind !== 'security_intercept');
}

/** The reject confirmation of one request (a write approval is "denied": the held request is dropped). */
export function rejectCopy(item: OperatorRequestRow) {
  const intercept = interceptOf(item);
  if (intercept?.reason === 'write_confirm')
    return {
      title: 'Deny this request?',
      description: `The held ${intercept.method !== undefined ? `${intercept.method} ` : ''}request to ${intercept.site_title} is dropped and the agent's ${item.tool ?? 'tool'} call is told it was refused.`,
      confirmLabel: 'Deny',
      danger: true,
    };
  return {
    title: 'Reject this request?',
    description: `The agent's ${item.tool ?? 'request_attention'} call fails with your rejection and the session is unblocked.`,
    confirmLabel: 'Reject',
    danger: true,
  };
}

/** Props. */
export interface LiveBoardProps {
  readonly pending: readonly OperatorRequestRow[];
  readonly confirms: readonly OperatorRequestRow[];
  readonly vaultEnabled: boolean;
}

/** Live board. */
export function LiveBoard({ pending, confirms, vaultEnabled }: LiveBoardProps) {
  const confirm = useConfirm();
  const resolve = useResolveAttention();
  const bulk = useBulkAttention();
  // Drafts survive list reloads (keyed by request id) and are lost on navigation (spec 04 §12.4).
  const [drafts, setDrafts] = useState<Readonly<Record<string, string>>>({});
  const draftsRef = useRef(drafts);
  draftsRef.current = drafts;
  const sorted = useMemo(() => [...pending].sort((a, b) => a.created_at - b.created_at), [pending]);

  // Stable identities: cards are memoised, so these must not change per render.
  const latest = useRef({ confirm, resolve });
  latest.current = { confirm, resolve };
  const onMessage = useCallback((id: string, value: string) => {
    setDrafts((d) => ({ ...d, [id]: value }));
  }, []);
  const onSettle = useCallback(async (item: OperatorRequestRow, decision: Decision) => {
    const { confirm: ask, resolve: mutation } = latest.current;
    const message = draftsRef.current[item.request_id] ?? '';
    if (decision === 'reject') {
      const ok = await ask(rejectCopy(item));
      if (!ok) return;
    }
    mutation.mutate({ requestId: item.request_id, decision, message });
  }, []);

  const many = bulkable(sorted);
  const held = sorted.length - many.length;
  const runBulk = async (action: Decision) => {
    const ok = await confirm({
      title: `${action === 'resolve' ? 'Resolve' : 'Reject'} all ${many.length} agent requests?`,
      description:
        'Every open agent request is settled with this decision; drafted messages are not sent.' +
        (held > 0
          ? ` ${held} site ${held === 1 ? 'check or write approval stays' : 'checks and write approvals stay'} open: decide each one on its card.`
          : ''),
      confirmLabel: action === 'resolve' ? 'Resolve all' : 'Reject all',
      danger: action === 'reject',
    });
    if (ok) bulk.mutate({ action, requestIds: many.map((item) => item.request_id) });
  };

  return (
    <div className="flex flex-col gap-8">
      <Section
        title="Open requests"
        actions={
          many.length > 1 ? (
            <>
              <Button
                type="button"
                variant="destructive-ghost"
                size="sm"
                disabled={bulk.isPending}
                onClick={() => void runBulk('reject')}
              >
                Reject all
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={bulk.isPending}
                onClick={() => void runBulk('resolve')}
              >
                Resolve all
              </Button>
            </>
          ) : undefined
        }
      >
        {sorted.length === 0 ? (
          <EmptyState
            kind="zero-data"
            variant="panel"
            size="sm"
            icon="check"
            title="Queue clear"
            description="When an agent hits a CAPTCHA, a 2FA prompt or an ambiguous choice, its request appears here for your decision."
          />
        ) : (
          <div className="flex flex-col gap-4">
            {sorted.map((item) => (
              <AttentionCard
                key={item.request_id}
                item={item}
                message={drafts[item.request_id] ?? ''}
                onMessage={onMessage}
                onSettle={onSettle}
                busy={bulk.isPending}
              />
            ))}
          </div>
        )}
      </Section>
      {vaultEnabled ? <ConfirmQueue items={confirms} title="Vault confirms" /> : null}
    </div>
  );
}
