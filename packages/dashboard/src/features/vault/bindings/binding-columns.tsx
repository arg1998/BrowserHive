/** @module features/vault/bindings/binding-columns — bindings table columns: binding (handle + title), item, who may fill (principals/slugs), allowed origins (`∗.` wildcard), group, flags, updated, actions; chip lists wrap so the actions stay on screen */
import type { VaultBinding, VaultGroup } from '@browserhive/contracts/http';
import { Chip } from '@/components/shared/Chip.tsx';
import { RelativeTime } from '@/components/shared/RelativeTime.tsx';
import type { DataTableColumn } from '@/components/shared/use-data-table.ts';
import { Button } from '@/components/ui/button.tsx';
import { Hint } from '@/components/ui/tooltip.tsx';
import { ICONS } from '@/lib/icons.ts';

/** Render an origin chip; wildcards show a distinct `∗.` prefix. */
export function OriginChip({
  origin,
  highlight = false,
}: {
  readonly origin: string;
  readonly highlight?: boolean;
}) {
  const wildcard = origin.startsWith('*.');
  return (
    <Chip tone={highlight ? 'vault' : 'neutral'} className="max-w-full font-mono">
      {wildcard ? (
        <span className="truncate">
          <span aria-hidden="true" className="text-muted-foreground">
            *.
          </span>
          <span className="sr-only">any subdomain of </span>
          {origin.slice(2)}
        </span>
      ) : (
        <span className="truncate">{origin}</span>
      )}
    </Chip>
  );
}

/** Flag labels as shown in the table. */
export const FLAG_LABEL = {
  dashboard_confirm: 'confirm',
  require_no_evaluate: 'no evaluate',
  redact_username: 'redact user',
} as const;

const FLAGS = Object.keys(FLAG_LABEL) as (keyof typeof FLAG_LABEL)[];

/** Column set. */
export function bindingColumns(options: {
  readonly groups: readonly VaultGroup[];
  readonly matches: ReadonlySet<string>;
  readonly onEdit: (binding: VaultBinding) => void;
  readonly onDelete: (binding: VaultBinding) => void;
}): readonly DataTableColumn<VaultBinding>[] {
  const groupName = (id: string | null) =>
    options.groups.find((g) => g.group_id === id)?.name ?? (id === null ? 'Ungrouped' : id);
  const Edit = ICONS.edit;
  const Delete = ICONS.delete;
  return [
    {
      id: 'handle',
      header: 'Binding',
      sortable: true,
      priority: 1,
      className: 'lg:min-w-52',
      cell: (b) => (
        <div className="flex min-w-0 flex-col gap-0.5">
          <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="font-mono text-sm font-medium [overflow-wrap:anywhere]">
              {b.handle}
            </span>
            {options.matches.has(b.handle) ? <Chip tone="success">matches tester</Chip> : null}
          </span>
          <span className="text-sm text-muted-foreground [overflow-wrap:anywhere]">
            {b.title !== b.handle ? b.title : b.item_name}
            {b.item_id === '' ? <span className="text-warn-text"> · unresolved item</span> : null}
          </span>
        </div>
      ),
    },
    {
      id: 'sessions',
      header: 'Who may fill',
      cell: (b) => (
        <span className="flex flex-wrap gap-1">
          {b.allow_all_sessions ? <Chip tone="warn">all sessions</Chip> : null}
          {b.authorized_principals.map((p) => (
            <Chip key={`p:${p}`} className="font-mono">
              {p}
            </Chip>
          ))}
          {b.allow_all_sessions
            ? null
            : b.authorized_session_slugs.map((s) => (
                <Chip key={`s:${s}`} className="font-mono">
                  {s}
                </Chip>
              ))}
          {!b.allow_all_sessions && b.authorized_session_slugs.length === 0 ? (
            <span className="text-sm text-muted-foreground">No sessions</span>
          ) : null}
        </span>
      ),
    },
    {
      id: 'origins',
      header: 'Allowed origins',
      grow: true,
      cell: (b) =>
        b.allowed_origins.length === 0 ? (
          <Chip tone="danger">no origins: fills blocked</Chip>
        ) : (
          <span className="flex min-w-0 flex-wrap gap-1">
            {b.allowed_origins.map((o) => (
              <OriginChip key={o} origin={o} />
            ))}
          </span>
        ),
    },
    {
      id: 'group',
      header: 'Group',
      priority: 3,
      className: 'min-w-24',
      cell: (b) => <span className="text-sm">{groupName(b.group_id)}</span>,
    },
    {
      id: 'flags',
      header: 'Flags',
      priority: 3,
      cell: (b) => {
        const on = FLAGS.filter((f) => b[f]);
        return on.length === 0 ? (
          <span className="text-sm text-muted-foreground">—</span>
        ) : (
          <span className="flex flex-wrap gap-1">
            {on.map((f) => (
              <Chip key={f} tone="vault">
                {FLAG_LABEL[f]}
              </Chip>
            ))}
          </span>
        );
      },
    },
    {
      id: 'updated_at',
      header: 'Updated',
      sortable: true,
      priority: 2,
      nowrap: true,
      cell: (b) => (
        <span className="flex flex-col text-sm">
          <RelativeTime at={b.updated_at} />
          <span className="font-mono text-muted-foreground">v{b.version}</span>
        </span>
      ),
    },
    {
      id: 'actions',
      header: 'Actions',
      hideHeader: true,
      align: 'end',
      nowrap: true,
      priority: 1,
      className: 'w-24',
      cell: (b) => (
        <span className="flex justify-end gap-1">
          <Hint label="Edit binding">
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label={`Edit ${b.handle}`}
              onClick={() => options.onEdit(b)}
            >
              <Edit aria-hidden="true" />
            </Button>
          </Hint>
          <Hint label="Delete binding">
            <Button
              type="button"
              variant="destructive-ghost"
              size="icon-sm"
              aria-label={`Delete ${b.handle}`}
              onClick={() => options.onDelete(b)}
            >
              <Delete aria-hidden="true" />
            </Button>
          </Hint>
        </span>
      ),
    },
  ];
}

/** Mobile card: handle, title, who and where, actions. */
export function BindingCard({
  binding: b,
  onEdit,
  onDelete,
}: {
  readonly binding: VaultBinding;
  readonly onEdit: (binding: VaultBinding) => void;
  readonly onDelete: (binding: VaultBinding) => void;
}) {
  return (
    <div className="flex flex-col gap-2.5">
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-0.5">
          <span className="font-mono text-sm font-medium [overflow-wrap:anywhere]">{b.handle}</span>
          <span className="text-sm text-muted-foreground [overflow-wrap:anywhere]">{b.title}</span>
        </div>
        <span className="flex shrink-0 gap-1">
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label={`Edit ${b.handle}`}
            onClick={() => onEdit(b)}
          >
            <ICONS.edit aria-hidden="true" />
          </Button>
          <Button
            type="button"
            variant="destructive-ghost"
            size="icon-sm"
            aria-label={`Delete ${b.handle}`}
            onClick={() => onDelete(b)}
          >
            <ICONS.delete aria-hidden="true" />
          </Button>
        </span>
      </div>
      <span className="flex flex-wrap gap-1">
        {b.allowed_origins.length === 0 ? (
          <Chip tone="danger">no origins: fills blocked</Chip>
        ) : (
          b.allowed_origins.map((o) => <OriginChip key={o} origin={o} />)
        )}
      </span>
      <span className="text-sm text-muted-foreground [overflow-wrap:anywhere]">
        {b.allow_all_sessions
          ? 'All sessions'
          : b.authorized_session_slugs.length === 0
            ? 'No sessions'
            : b.authorized_session_slugs.join(', ')}
        {' · updated '}
        <RelativeTime at={b.updated_at} />
      </span>
    </div>
  );
}
