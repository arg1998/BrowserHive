/** @module app/shell/SidebarNav — nav items from the route table: expanded rows or 40px rail buttons with tooltips, badges (dot in the rail), "Not enabled" group only once `/system` is known */
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useApi } from '@/app/providers/AuthProvider.tsx';
import { useTopic } from '@/app/providers/SocketProvider.tsx';
import { Hint } from '@/components/ui/tooltip.tsx';
import { keys } from '@/lib/api/keys.ts';
import { ICONS } from '@/lib/icons.ts';
import { cn } from '@/lib/utils.ts';
import { type NavItem, useNavItems } from './use-route-table.ts';

/** Badge counts and capabilities the nav needs. `vaultEnabled` is `null` until `/system` answered. */
export function useNavSignals() {
  const api = useApi();
  const system = useQuery({ queryKey: keys.system.status(), queryFn: () => api.getSystem() });
  const attention = useQuery({
    queryKey: keys.attention.openCount(),
    queryFn: async () =>
      (await api.listAttention({ query: { status: ['pending'], limit: 1 } })).open_count,
  });
  const vaultEnabled = system.data === undefined ? null : system.data.vault.enabled;
  const confirms = useQuery({
    queryKey: keys.vault.confirmCount(),
    queryFn: async () =>
      (await api.listVaultConfirm({ query: { status: ['pending'], limit: 1, total: true } })).page
        .total ?? 0,
    // Only when the vault is known to be on: otherwise the endpoint 404s.
    enabled: vaultEnabled === true,
  });
  useTopic('attention');
  useTopic(vaultEnabled === true ? 'vault.confirm' : null);
  useTopic('system');
  return {
    vaultEnabled,
    attentionOpen: attention.data ?? 0,
    confirmsOpen: confirms.data ?? 0,
    version: system.data?.version ?? null,
  };
}

/** Props. */
export interface SidebarNavProps {
  readonly collapsed: boolean;
  readonly onNavigate?: () => void;
}

/** Split items into enabled and not-enabled groups; vault items wait for `/system` (pure, tested). */
export function groupNavItems(
  items: readonly NavItem[],
  vaultEnabled: boolean | null,
): { readonly enabled: readonly NavItem[]; readonly disabled: readonly NavItem[] } {
  return {
    enabled: items.filter((i) => i.requires !== 'vault' || vaultEnabled === true),
    disabled: items.filter((i) => i.requires === 'vault' && vaultEnabled === false),
  };
}

/** Sidebar nav. */
export function SidebarNav({ collapsed, onNavigate }: SidebarNavProps) {
  const items = useNavItems();
  const { vaultEnabled, attentionOpen, confirmsOpen } = useNavSignals();
  const { enabled, disabled } = groupNavItems(items, vaultEnabled);
  const badgeFor = (item: NavItem): number =>
    item.to === '/attention' ? attentionOpen : item.to === '/vault' ? confirmsOpen : 0;
  return (
    <nav
      aria-label="Primary"
      className={cn(
        'flex min-h-0 flex-1 flex-col gap-1 overflow-x-hidden overflow-y-auto py-3',
        collapsed ? 'items-center px-2' : 'px-3',
      )}
    >
      <ul className={cn('flex flex-col gap-0.5', collapsed && 'items-center')}>
        {enabled.map((item) => (
          <li key={item.id}>
            <NavLink
              item={item}
              badge={badgeFor(item)}
              collapsed={collapsed}
              {...(onNavigate !== undefined && { onNavigate })}
            />
          </li>
        ))}
      </ul>
      {disabled.length > 0 ? (
        <>
          {collapsed ? (
            <div aria-hidden="true" className="my-2 h-px w-6 bg-sidebar-border" />
          ) : (
            <p className="mt-5 mb-1 px-2.5 text-xs font-medium text-muted-foreground">
              Not enabled
            </p>
          )}
          <ul className={cn('flex flex-col gap-0.5', collapsed && 'items-center')}>
            {disabled.map((item) => (
              <li key={item.id}>
                <NavLink
                  item={item}
                  badge={0}
                  collapsed={collapsed}
                  {...(onNavigate !== undefined && { onNavigate })}
                  locked
                />
              </li>
            ))}
          </ul>
        </>
      ) : null}
    </nav>
  );
}

function NavLink({
  item,
  badge,
  collapsed,
  locked = false,
  onNavigate,
}: {
  readonly item: NavItem;
  readonly badge: number;
  readonly collapsed: boolean;
  readonly locked?: boolean;
  readonly onNavigate?: () => void;
}) {
  const Icon = ICONS[item.icon];
  const Lock = ICONS.lock;
  const badgeText = badge > 99 ? '99+' : String(badge);
  const link = (
    <Link
      to={item.to}
      onClick={onNavigate}
      activeOptions={{ exact: false, includeSearch: false }}
      aria-label={collapsed ? (locked ? `${item.label} (not enabled)` : item.label) : undefined}
      className={cn(
        'group/nav relative flex items-center rounded-md text-sidebar-foreground transition-colors duration-(--duration-fast) hover:bg-sidebar-accent/60 hover:text-sidebar-accent-foreground [&.active]:bg-sidebar-accent [&.active]:text-sidebar-accent-foreground',
        collapsed ? 'size-10 justify-center' : 'h-9 gap-3 px-2.5 text-base',
        // Locked items stay readable (≥ 4.5:1) and look like any active item once opened.
        locked && 'text-muted-foreground',
      )}
      activeProps={{ 'aria-current': 'page', className: 'active font-medium' }}
    >
      <Icon
        aria-hidden="true"
        className={cn(
          'shrink-0 text-muted-foreground transition-colors group-hover/nav:text-sidebar-accent-foreground group-[.active]/nav:text-sidebar-accent-foreground',
          collapsed ? 'size-5' : 'size-4.5',
          locked && 'opacity-70 group-[.active]/nav:opacity-100',
        )}
      />
      {!collapsed ? <span className="min-w-0 flex-1 truncate">{item.label}</span> : null}
      {!collapsed && locked ? (
        <Lock aria-hidden="true" className="size-3.5 shrink-0 text-subtle-foreground" />
      ) : null}
      {badge > 0 ? <span className="sr-only">{`, ${badge} open`}</span> : null}
      {badge > 0 && !collapsed ? (
        <span
          aria-hidden="true"
          className="flex h-5 min-w-5 items-center justify-center rounded-full bg-warn-solid px-1.5 text-xs font-semibold text-warn-on-solid tabular-nums"
        >
          {badgeText}
        </span>
      ) : null}
      {badge > 0 && collapsed ? (
        <span
          aria-hidden="true"
          className="absolute top-1.5 right-1.5 size-2 rounded-full bg-warn-solid ring-2 ring-sidebar"
        />
      ) : null}
    </Link>
  );
  if (!collapsed) return link;
  return (
    <Hint
      side="right"
      label={
        locked
          ? `${item.label} · not enabled`
          : badge > 0
            ? `${item.label} · ${badgeText} open`
            : item.label
      }
    >
      {link}
    </Hint>
  );
}
