/** @module features/vault/status/StatusHeader — vault state for the page header: unlock state badge (checking/unlocked/locked), capability meta line, Sync and Lock actions, and the sync result notice (spec 04 §12.7) */
import type { SyncVaultResponse, VaultOverview } from '@browserhive/contracts/http';
import type { UseQueryResult } from '@tanstack/react-query';
import { Callout } from '@/components/shared/Callout.tsx';
import { ErrorCode } from '@/components/shared/ErrorState.tsx';
import { RelativeTime } from '@/components/shared/RelativeTime.tsx';
import { TonePill } from '@/components/shared/StatusBadge.tsx';
import { Button } from '@/components/ui/button.tsx';
import { Hint } from '@/components/ui/tooltip.tsx';
import type { AppError } from '@/lib/api/errors.ts';
import { ICONS } from '@/lib/icons.ts';
import { cn } from '@/lib/utils.ts';

type VaultStatus = UseQueryResult<
  { readonly unlocked: boolean; readonly checked_at: number },
  unknown
>;

/** Result of the last sync. */
export type SyncOutcome =
  | { readonly ok: true; readonly result: SyncVaultResponse }
  | { readonly ok: false; readonly error: AppError };

/** Sync result text (item and group counts, or why the sync failed). */
export function syncMessage(outcome: SyncOutcome): string {
  if (outcome.ok) {
    const { items, groups } = outcome.result;
    return `Synced ${items} item${items === 1 ? '' : 's'} in ${groups} group${groups === 1 ? '' : 's'}.`;
  }
  if (outcome.error.code === 'VAULT_LOCKED')
    return 'Cannot sync while the backend is locked. Unlock it, then sync.';
  if (outcome.error.code === 'VAULT_SYNC_UNSUPPORTED')
    return 'This backend does not support syncing.';
  return `Sync failed: ${outcome.error.message}`;
}

/** Unlock state badge. */
export function VaultStateBadge({
  overview,
  status,
}: {
  readonly overview: VaultOverview;
  readonly status: VaultStatus;
}) {
  if (status.isPending)
    return (
      <TonePill entry={{ label: `${overview.backend.id} · checking…`, tone: 'neutral' }} pulse />
    );
  const unlocked = status.data?.unlocked ?? overview.unlocked;
  return (
    <TonePill
      entry={{
        label: `${overview.backend.id} · ${unlocked ? 'unlocked' : 'locked'}`,
        tone: unlocked ? 'vault' : 'warn',
        icon: 'lock',
      }}
    />
  );
}

/** Capability and count facts for the header meta line. */
export function VaultMeta({
  overview,
  status,
}: {
  readonly overview: VaultOverview;
  readonly status: VaultStatus;
}) {
  const caps = overview.backend.capabilities;
  const facts = [
    `${overview.bindings_count} ${overview.bindings_count === 1 ? 'binding' : 'bindings'}`,
    `${overview.policies_count} group ${overview.policies_count === 1 ? 'policy' : 'policies'}`,
    caps.writable ? 'writable' : 'read-only',
    `${caps.grouping} grouping`,
    ...(caps.totp ? ['TOTP'] : []),
  ];
  return (
    <>
      {facts.map((fact, i) => (
        <span key={fact} className="flex items-center gap-2">
          {i > 0 ? <span aria-hidden="true">·</span> : null}
          {fact}
        </span>
      ))}
      {status.data !== undefined ? (
        <span className="flex items-center gap-2">
          <span aria-hidden="true">·</span>
          <span>
            checked <RelativeTime at={status.data.checked_at} />
          </span>
        </span>
      ) : null}
    </>
  );
}

/** Header actions. */
export function VaultActions({
  overview,
  unlocked,
  syncing,
  locking,
  onSync,
  onLock,
}: {
  readonly overview: VaultOverview;
  readonly unlocked: boolean;
  readonly syncing: boolean;
  readonly locking: boolean;
  readonly onSync: () => void;
  readonly onLock: () => void;
}) {
  const caps = overview.backend.capabilities;
  const Refresh = ICONS.refresh;
  const Lock = ICONS.lock;
  return (
    <>
      {caps.sync ? (
        <Hint label="Pull the backend's remote vault so new or renamed items appear">
          <Button type="button" variant="outline" size="sm" disabled={syncing} onClick={onSync}>
            <Refresh aria-hidden="true" className={cn(syncing && 'motion-safe:animate-spin')} />
            {syncing ? 'Syncing…' : 'Sync vault'}
          </Button>
        </Hint>
      ) : null}
      {unlocked && caps.unlock !== 'none' ? (
        <Button type="button" variant="outline" size="sm" disabled={locking} onClick={onLock}>
          <Lock aria-hidden="true" />
          Lock
        </Button>
      ) : null}
    </>
  );
}

/** Sync result notice. */
export function SyncNotice({
  outcome,
  onDismiss,
}: {
  readonly outcome: SyncOutcome;
  readonly onDismiss: () => void;
}) {
  return (
    <Callout
      tone={outcome.ok ? 'success' : 'warn'}
      title={outcome.ok ? 'Vault synced' : 'Sync did not complete'}
      action={
        <span className="flex items-center gap-2">
          {outcome.ok ? null : <ErrorCode error={outcome.error} />}
          <Button type="button" variant="ghost" size="xs" onClick={onDismiss}>
            Dismiss
          </Button>
        </span>
      }
    >
      {syncMessage(outcome)}
      {outcome.ok ? (
        <>
          {' '}
          Last sync <RelativeTime at={outcome.result.synced_at} mode="both" />.
        </>
      ) : null}
    </Callout>
  );
}
