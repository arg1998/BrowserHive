/** @module features/vault/bindings/BindingsPanel — bindings table with search/group filter, create/edit drawer, confirmed delete, and the visible rollback callout on `CONFLICT` (spec 04 §12.7, §11) */
import type { VaultBinding } from '@browserhive/contracts/http';
import { useState } from 'react';
import { useConfirm } from '@/app/providers/ConfirmProvider.tsx';
import { Callout } from '@/components/shared/Callout.tsx';
import { DataPanel } from '@/components/shared/DataPanel.tsx';
import { DataTable } from '@/components/shared/DataTable.tsx';
import { EmptyState } from '@/components/shared/EmptyState.tsx';
import { FilterBar } from '@/components/shared/FilterBar.tsx';
import { SkeletonTable } from '@/components/shared/Skeletons.tsx';
import { useCursorPager } from '@/components/shared/use-cursor-pages.ts';
import { Button } from '@/components/ui/button.tsx';
import { Hint } from '@/components/ui/tooltip.tsx';
import { ICONS } from '@/lib/icons.ts';
import { useSearchState } from '@/lib/search/use-search-state.ts';
import { useVaultBindings, useVaultGroups, useVaultItems } from '../api.ts';
import { BINDING_SORT_KEYS, type VaultSearch } from '../search.ts';
import { useTesterResult } from '../tester/TesterPanel.tsx';
import { BindingDrawer } from './BindingDrawer.tsx';
import { BindingCard, bindingColumns } from './binding-columns.tsx';
import { type BindingConflict, useDeleteBinding, useSaveBinding } from './use-save-binding.ts';

/** Props. */
export interface BindingsPanelProps {
  readonly unlocked: boolean;
  /** Handles to highlight; defaults to the `would_fill` set of the tester in the URL. */
  readonly matches?: ReadonlySet<string>;
}

const NO_MATCHES: ReadonlySet<string> = new Set();

/** Bindings panel. */
export function BindingsPanel({ unlocked, matches: given }: BindingsPanelProps) {
  const { search, set, clear } = useSearchState<VaultSearch>();
  const tester = useTesterResult(search);
  const matches =
    given ??
    (tester.result.data === undefined ? NO_MATCHES : new Set(tester.result.data.would_fill));
  const confirm = useConfirm();
  const [editor, setEditor] = useState<{
    readonly binding?: VaultBinding | undefined;
    readonly draft?: BindingConflict['values'];
  } | null>(null);
  const [conflict, setConflict] = useState<BindingConflict | null>(null);
  const query = {
    limit: search.ps,
    total: true,
    ...(search.sort !== undefined && { sort: search.sort as (typeof BINDING_SORT_KEYS)[number] }),
    ...(search.dir !== undefined && { dir: search.dir }),
    ...(search.q !== undefined && { q: search.q }),
    ...(search.group !== undefined && { group_id: search.group }),
  };
  const pager = useCursorPager();
  const bindings = useVaultBindings(query, search.page, pager);
  const groups = useVaultGroups(unlocked);
  const items = useVaultItems(undefined, unlocked && editor !== null);
  const save = useSaveBinding((c) => setConflict(c));
  const remove = useDeleteBinding();
  const groupRows = groups.data?.data ?? [];
  const onDelete = async (binding: VaultBinding) => {
    const ok = await confirm({
      title: `Delete binding ${binding.handle}?`,
      description: 'Agents can no longer fill this credential. The backend item is not touched.',
      confirmLabel: 'Delete',
      danger: true,
    });
    if (ok) remove.mutate(binding.handle);
  };
  const columns = bindingColumns({
    groups: groupRows,
    matches,
    onEdit: (binding) => setEditor({ binding }),
    onDelete: (binding) => void onDelete(binding),
  });
  const Plus = ICONS.plus;
  const current = (handle: string) => bindings.data?.data.find((b) => b.handle === handle);
  return (
    <div className="flex flex-col gap-3">
      {conflict !== null ? (
        <Callout
          tone="danger"
          title={`Edit to ${conflict.handle} was rolled back`}
          action={
            <span className="flex flex-wrap gap-2">
              <Button
                type="button"
                size="sm"
                onClick={() => {
                  setEditor({ binding: current(conflict.handle), draft: conflict.values });
                  setConflict(null);
                }}
              >
                Reapply my changes
              </Button>
              <Button type="button" variant="ghost" size="sm" onClick={() => setConflict(null)}>
                Keep server version
              </Button>
            </span>
          }
        >
          Someone changed this binding while you edited it. The server holds version{' '}
          <span className="font-mono">
            {conflict.serverVersion ?? current(conflict.handle)?.version ?? '?'}
          </span>
          ; your edit was based on version{' '}
          <span className="font-mono">{conflict.baseVersion ?? '—'}</span>. The table shows the
          server's row.
        </Callout>
      ) : null}
      <FilterBar
        search={{
          param: 'q',
          placeholder: 'Search handle, title, item or origin…',
          value: search.q,
        }}
        tokens={
          search.group !== undefined
            ? [
                {
                  key: 'group',
                  value: groupRows.find((g) => g.group_id === search.group)?.name ?? search.group,
                  onRemove: () => set({ group: undefined }),
                },
              ]
            : []
        }
        {...(bindings.data?.page.total !== undefined && { matching: bindings.data.page.total })}
        onChange={(param, value) => {
          pager.reset();
          set({ [param]: value });
        }}
        onClear={() => {
          pager.reset();
          clear(['tab']);
        }}
        end={
          <Hint label={unlocked ? null : 'Unlock the backend to pick an item for a new binding'}>
            <span className="inline-flex" tabIndex={unlocked ? undefined : 0}>
              <Button type="button" disabled={!unlocked} onClick={() => setEditor({})}>
                <Plus aria-hidden="true" />
                New binding
              </Button>
            </span>
          </Hint>
        }
      />
      <DataPanel
        query={bindings}
        skeleton={<SkeletonTable />}
        isEmpty={() => false}
        empty={null}
        errorVariant="panel"
      >
        {(data) => (
          <DataTable<VaultBinding>
            label="Vault bindings"
            columns={columns}
            rows={data.data}
            {...(data.page.total !== undefined && { rowCount: data.page.total })}
            hasNext={data.page.next_cursor !== null}
            state={{ sort: search.sort, dir: search.dir, page: search.page, pageSize: search.ps }}
            sortKeys={BINDING_SORT_KEYS}
            getRowId={(b) => b.handle}
            rowLabel={(b) => b.handle}
            onRowClick={(b) => setEditor({ binding: b })}
            renderCard={(b) => (
              <BindingCard
                binding={b}
                onEdit={(binding) => setEditor({ binding })}
                onDelete={(binding) => void onDelete(binding)}
              />
            )}
            onStateChange={(patch) => {
              if (patch.page === undefined) pager.reset();
              set({ ...patch });
            }}
            emptyState={
              search.q !== undefined || search.group !== undefined ? (
                <EmptyState
                  kind="zero-results"
                  title="No bindings match"
                  onClear={() => clear(['tab'])}
                />
              ) : (
                <EmptyState
                  kind="zero-data"
                  icon="vault"
                  title="No bindings yet"
                  description={
                    unlocked
                      ? 'A binding lets matching sessions fill one credential on its allowed origins.'
                      : 'Unlock the backend, then add a binding to let sessions fill a credential.'
                  }
                />
              )
            }
          />
        )}
      </DataPanel>
      <BindingDrawer
        open={editor !== null}
        binding={editor?.binding}
        draft={editor?.draft}
        items={items.data?.data ?? []}
        groups={groupRows}
        busy={save.isPending}
        onClose={() => setEditor(null)}
        onSubmit={(values) => {
          const previous = editor?.binding;
          setEditor(null);
          setConflict(null);
          save.mutate({ values, previous });
        }}
      />
    </div>
  );
}
