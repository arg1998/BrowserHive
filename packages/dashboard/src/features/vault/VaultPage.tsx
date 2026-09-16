/** @module features/vault/VaultPage — `/vault`: one disabled panel when no backend is attached; otherwise a header carrying the unlock state, capabilities and Sync/Lock, the unlock form while locked, and URL tabs (bindings, groups, confirms, tester, export/import) that scroll instead of clipping on mobile (spec 04 §12.7) */
import { useState } from 'react';
import { useTopic } from '@/app/providers/SocketProvider.tsx';
import { ErrorState } from '@/components/shared/ErrorState.tsx';
import { PageHeader } from '@/components/shared/PageHeader.tsx';
import { SkeletonCard, SkeletonKv } from '@/components/shared/Skeletons.tsx';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs.tsx';
import { toAppError } from '@/lib/api/errors.ts';
import { useSearchState } from '@/lib/search/use-search-state.ts';
import {
  isVaultOff,
  useLockVault,
  useSyncVault,
  useVaultConfirms,
  useVaultEnabled,
  useVaultOverview,
  useVaultStatus,
} from './api.ts';
import { BindingsPanel } from './bindings/BindingsPanel.tsx';
import { ConfirmQueue } from './confirm/ConfirmQueue.tsx';
import { GroupsPanel } from './groups/GroupsPanel.tsx';
import { VAULT_TABS, type VaultSearch, type VaultTab } from './search.ts';
import {
  SyncNotice,
  type SyncOutcome,
  VaultActions,
  VaultMeta,
  VaultStateBadge,
} from './status/StatusHeader.tsx';
import { UnlockCard } from './status/UnlockCard.tsx';
import { VaultDisabled } from './status/VaultDisabled.tsx';
import { TesterPanel } from './tester/TesterPanel.tsx';
import { TransferPanel } from './transfer/TransferPanel.tsx';

const TAB_LABEL: Record<VaultTab, string> = {
  bindings: 'Bindings',
  groups: 'Groups',
  confirms: 'Confirms',
  tester: 'Tester',
  transfer: 'Export / import',
};

const TITLE = 'Vault';
const DESCRIPTION = 'Which agents may fill which credentials, where. Policy only, never secrets.';

/** Vault page. */
export function VaultPage() {
  const { search, set } = useSearchState<VaultSearch>();
  const enabled = useVaultEnabled();
  const overview = useVaultOverview(enabled === true);
  const available = enabled === true && overview.data !== undefined;
  const status = useVaultStatus(available);
  const confirms = useVaultConfirms(available);
  const sync = useSyncVault();
  const lock = useLockVault();
  const [outcome, setOutcome] = useState<SyncOutcome | null>(null);
  useTopic(available ? 'vault.confirm' : null);
  useTopic(available ? 'vault.config' : null);

  if (enabled === false || isVaultOff(overview.error)) {
    return (
      <div className="flex flex-col gap-6">
        <PageHeader title={TITLE} description={DESCRIPTION} />
        <VaultDisabled />
      </div>
    );
  }
  if (overview.isError) {
    return (
      <div className="flex flex-col gap-6">
        <PageHeader title={TITLE} description={DESCRIPTION} />
        <ErrorState
          tier="region"
          variant="panel"
          error={toAppError(overview.error)}
          onRetry={() => void overview.refetch()}
        />
      </div>
    );
  }
  if (overview.data === undefined) {
    return (
      <div className="flex flex-col gap-6">
        <PageHeader title={TITLE} description={DESCRIPTION} />
        <SkeletonKv count={2} />
        <SkeletonCard />
      </div>
    );
  }
  const data = overview.data;
  const unlocked = status.data?.unlocked ?? data.unlocked;
  const pending = confirms.data?.data ?? [];
  const onSync = () => {
    setOutcome(null);
    sync.mutate(undefined, {
      onSuccess: (result) => setOutcome({ ok: true, result }),
      onError: (error) => setOutcome({ ok: false, error: toAppError(error) }),
    });
  };
  return (
    <Tabs
      value={search.tab}
      onValueChange={(value) =>
        set({ tab: VAULT_TABS.find((t) => t === value), page: search.page })
      }
      className="gap-6"
    >
      <PageHeader
        title={TITLE}
        badge={<VaultStateBadge overview={data} status={status} />}
        description={DESCRIPTION}
        meta={<VaultMeta overview={data} status={status} />}
        actions={
          <VaultActions
            overview={data}
            unlocked={unlocked}
            syncing={sync.isPending}
            locking={lock.isPending}
            onSync={onSync}
            onLock={() => lock.mutate()}
          />
        }
        tabs={
          <TabsList aria-label="Vault sections">
            {VAULT_TABS.map((tab) => (
              <TabsTrigger key={tab} value={tab}>
                {TAB_LABEL[tab]}
                {tab === 'confirms' && pending.length > 0 ? (
                  <span className="flex h-5 min-w-5 items-center justify-center rounded-full bg-vault-solid px-1.5 text-xs font-semibold text-vault-on-solid tabular-nums">
                    {pending.length}
                  </span>
                ) : null}
              </TabsTrigger>
            ))}
          </TabsList>
        }
      />
      {outcome !== null ? (
        <SyncNotice outcome={outcome} onDismiss={() => setOutcome(null)} />
      ) : null}
      {!unlocked && status.data !== undefined ? <UnlockCard unlock={data.unlock} /> : null}
      <TabsContent value="bindings">
        <BindingsPanel unlocked={unlocked} />
      </TabsContent>
      <TabsContent value="groups">
        <GroupsPanel unlocked={unlocked} />
      </TabsContent>
      <TabsContent value="confirms">
        <ConfirmQueue items={pending} />
      </TabsContent>
      <TabsContent value="tester">
        <TesterPanel unlocked={unlocked} />
      </TabsContent>
      <TabsContent value="transfer">
        <TransferPanel />
      </TabsContent>
    </Tabs>
  );
}
