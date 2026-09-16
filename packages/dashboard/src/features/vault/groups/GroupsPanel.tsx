/** @module features/vault/groups/GroupsPanel — group (folder) policies: duplicates warning, accordion with mode/flag pills and counts, open id in `?folder` (spec 04 §12.7) */
import type { VaultGroup } from '@browserhive/contracts/http';
import { UNGROUPED_GROUP_KEY } from '@browserhive/contracts/http';
import { Callout } from '@/components/shared/Callout.tsx';
import { Chip } from '@/components/shared/Chip.tsx';
import { DataPanel } from '@/components/shared/DataPanel.tsx';
import { EmptyState } from '@/components/shared/EmptyState.tsx';
import { SkeletonCard } from '@/components/shared/Skeletons.tsx';
import { Button } from '@/components/ui/button.tsx';
import { ICONS } from '@/lib/icons.ts';
import { useSearchState } from '@/lib/search/use-search-state.ts';
import { cn } from '@/lib/utils.ts';
import { useVaultGroups } from '../api.ts';
import type { VaultSearch } from '../search.ts';
import { GroupPolicyForm } from './GroupPolicyForm.tsx';

const MODE_PILL = {
  manual: { label: 'manual', tone: 'neutral' },
  allow_all: { label: 'allow all', tone: 'vault' },
  reject_all: { label: 'reject all', tone: 'danger' },
} as const;

/** Stable URL key of a group. */
export function groupKey(group: Pick<VaultGroup, 'group_id'>): string {
  return group.group_id ?? UNGROUPED_GROUP_KEY;
}

function GroupHeader({
  group,
  open,
  onToggle,
}: {
  readonly group: VaultGroup;
  readonly open: boolean;
  readonly onToggle: () => void;
}) {
  const Chevron = ICONS.chevronRight;
  const mode = MODE_PILL[group.policy?.access_mode ?? 'manual'];
  const p = group.policy;
  return (
    <h3>
      <button
        type="button"
        aria-expanded={open}
        onClick={onToggle}
        className="flex w-full cursor-pointer flex-wrap items-center gap-x-3 gap-y-1.5 rounded-xl px-4 py-3 text-left transition-colors hover:bg-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
      >
        <span className="flex min-w-0 flex-[1_1_12rem] items-center gap-2">
          <Chevron
            aria-hidden="true"
            className={cn(
              'size-4 shrink-0 text-muted-foreground transition-transform duration-(--duration-fast)',
              open && 'rotate-90',
            )}
          />
          <span className="min-w-0 font-medium [overflow-wrap:anywhere]">{group.name}</span>
        </span>
        <span className="flex flex-wrap items-center gap-1.5 pl-6 sm:pl-0">
          <Chip tone={mode.tone}>{mode.label}</Chip>
          {p?.dashboard_confirm === true ? <Chip tone="vault">confirm</Chip> : null}
          {p?.require_no_evaluate === true ? <Chip tone="vault">no evaluate</Chip> : null}
          {p?.redact_username === true ? <Chip tone="vault">redact user</Chip> : null}
          <span className="ml-1 text-sm text-muted-foreground tabular-nums">
            {group.item_count} items · {group.bound_count} bound
          </span>
        </span>
      </button>
    </h3>
  );
}

/** Groups panel. */
export function GroupsPanel({ unlocked }: { readonly unlocked: boolean }) {
  const { search, set } = useSearchState<VaultSearch>();
  const groups = useVaultGroups(unlocked);
  if (!unlocked) {
    return (
      <EmptyState
        kind="not-enabled"
        variant="panel"
        title="Unlock the backend to see its groups"
        description="Groups and their policies are read from the backend."
        size="sm"
      />
    );
  }
  return (
    <DataPanel
      query={groups}
      skeleton={<SkeletonCard />}
      empty={
        <EmptyState
          kind="zero-data"
          icon="vault"
          title="No folders"
          description="The backend returned no folders. Add items in the backend, then sync."
        />
      }
    >
      {(data) => (
        <div className="flex flex-col gap-3">
          {data.duplicates.length > 0 ? (
            <Callout tone="warn" title="Duplicate group names">
              {data.duplicates.map((d) => `${d.name} (${d.ids.length})`).join(', ')} — handles
              derived from these names are ambiguous.
            </Callout>
          ) : null}
          <ul className="flex flex-col gap-2">
            {data.data.map((group) => {
              const key = groupKey(group);
              const open = search.folder === key;
              return (
                <li key={key} className="rounded-xl border bg-card shadow-xs dark:shadow-none">
                  <GroupHeader
                    group={group}
                    open={open}
                    onToggle={() => set({ folder: open ? undefined : key, page: search.page })}
                  />
                  {open ? (
                    <div className="flex flex-col gap-4 border-t px-4 py-4 sm:pl-10">
                      <GroupPolicyForm group={group} />
                      <div>
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          onClick={() => set({ tab: 'bindings', group: key })}
                        >
                          Show bindings in {group.name}
                        </Button>
                      </div>
                    </div>
                  ) : null}
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </DataPanel>
  );
}
