/** @module app/shell/SidebarNav — nav items from the route table: expanded rows or 40px rail buttons with tooltips, badges (dot in the rail), "Not enabled" group only once `/system` is known */
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useApi } from '@/app/providers/AuthProvider.tsx';
import { useTopic } from '@/app/providers/SocketProvider.tsx';
import { Hint } from '@/components/ui/tooltip.tsx';
import { TEMPLATES_TOPIC } from '@/features/templates/live.ts';
import { keys } from '@/lib/api/keys.ts';
import { ICONS } from '@/lib/icons.ts';
import { cn } from '@/lib/utils.ts';
import { type NavItem, useNavItems } from './use-route-table.ts';

/** Health states of a template site that need the operator to sign in again (spec 13 §11.4). */
const NEEDS_SIGN_IN: ReadonlySet<unknown> = new Set(['signed_out', 'challenged']);

/** Sites that need a sign-in, from the `health` facet of `GET /templates` (pure, tested). */
export function sitesNeedingSignIn(
  health: readonly { readonly value: unknown; readonly count: number }[] | undefined,
): number {
  return (health ?? []).reduce((n, f) => (NEEDS_SIGN_IN.has(f.value) ? n + f.count : n), 0);
}

/** `true`/`false` from a boolean config key's value; `null` while unknown. */
function configFlag(
  config:
    | { readonly keys: readonly { readonly key: string; readonly value: unknown }[] }
    | undefined,
  key: string,
): boolean | null {
  const value = config?.keys.find((k) => k.key === key)?.value;
  return typeof value === 'boolean' ? value : null;
}

/** Badge counts and capabilities the nav needs. A capability is `null` until its source answered. */
export function useNavSignals() {
  const api = useApi();
  const queryClient = useQueryClient();
  const system = useQuery({ queryKey: keys.system.status(), queryFn: () => api.getSystem() });
  const config = useQuery({ queryKey: keys.system.config(), queryFn: () => api.getSystemConfig() });
  const attention = useQuery({
    queryKey: keys.attention.openCount(),
    queryFn: async () =>
      (await api.listAttention({ query: { status: ['pending'], limit: 1 } })).open_count,
  });
  const vaultEnabled = system.data === undefined ? null : system.data.vault.enabled;
  const templatesEnabled = configFlag(config.data, 'templates');
  const confirms = useQuery({
    queryKey: keys.vault.confirmCount(),
    queryFn: async () =>
      (await api.listVaultConfirm({ query: { status: ['pending'], limit: 1, total: true } })).page
        .total ?? 0,
    // Only when the vault is known to be on: otherwise the endpoint 404s.
    enabled: vaultEnabled === true,
  });
  const signIns = useQuery({
    queryKey: [...keys.templates.lists(), 'nav-badge'],
    queryFn: async () =>
      sitesNeedingSignIn((await api.listTemplates({ query: { limit: 1 } })).facets.health),
    enabled: templatesEnabled !== false,
  });
  useTopic('attention');
  useTopic(vaultEnabled === true ? 'vault.confirm' : null);
  useTopic('system');
  useTopic(templatesEnabled === false ? null : TEMPLATES_TOPIC, (event) => {
    // Only changes that can move the sign-in count (the browser's minute ticks do not).
    if (
      event.type === 'template.changed' ||
      event.type === 'template.health' ||
      event.type === 'template.removed'
    )
      void queryClient.invalidateQueries({ queryKey: [...keys.templates.lists(), 'nav-badge'] });
  });
  return {
    capabilities: {
      vault: vaultEnabled,
      templates: templatesEnabled,
      // Site packs ship with a later phase of the templates program (spec 13 §17 T3a).
      sitePacks: false,
    } satisfies NavCapabilities,
    attentionOpen: attention.data ?? 0,
    confirmsOpen: confirms.data ?? 0,
    signInsNeeded: signIns.data ?? 0,
    version: system.data?.version ?? null,
  };
}

/** Props. */
export interface SidebarNavProps {
  readonly collapsed: boolean;
  readonly onNavigate?: () => void;
}

/** What is on, per `requires` value; `null` = not known yet. */
export interface NavCapabilities {
  readonly vault: boolean | null;
  readonly templates: boolean | null;
  readonly sitePacks: boolean | null;
}

/**
 * Where an item goes: `enabled`, `disabled` ("Not enabled") or `hidden`. Vault items wait for
 * `/system`; template items show while the config is loading (templates are on by default).
 */
function placement(
  requires: NavItem['requires'],
  caps: NavCapabilities,
): 'enabled' | 'disabled' | 'hidden' {
  switch (requires) {
    case 'vault':
      return caps.vault === true ? 'enabled' : caps.vault === false ? 'disabled' : 'hidden';
    case 'templates':
      return caps.templates === false ? 'disabled' : 'enabled';
    case 'sitePacks':
      return caps.sitePacks === true && caps.templates !== false ? 'enabled' : 'disabled';
    default:
      return 'enabled';
  }
}

/** Split items into enabled and not-enabled groups (pure, tested). */
export function groupNavItems(
  items: readonly NavItem[],
  caps: NavCapabilities,
): { readonly enabled: readonly NavItem[]; readonly disabled: readonly NavItem[] } {
  return {
    enabled: items.filter((i) => placement(i.requires, caps) === 'enabled'),
    disabled: items.filter((i) => placement(i.requires, caps) === 'disabled'),
  };
}

/** A nav badge: the count and what it counts, for screen readers and the rail tooltip. */
interface Badge {
  readonly count: number;
  readonly noun: string;
}

/** Sidebar nav. */
export function SidebarNav({ collapsed, onNavigate }: SidebarNavProps) {
  const items = useNavItems();
  const { capabilities, attentionOpen, confirmsOpen, signInsNeeded } = useNavSignals();
  const { enabled, disabled } = groupNavItems(items, capabilities);
  const badgeFor = (item: NavItem): Badge => {
    if (item.to === '/attention') return { count: attentionOpen, noun: 'open' };
    if (item.to === '/vault') return { count: confirmsOpen, noun: 'open' };
    if (item.to === '/templates') return { count: signInsNeeded, noun: 'need a sign-in' };
    return { count: 0, noun: '' };
  };
  const nested = (item: NavItem, list: readonly NavItem[]) =>
    item.parent !== undefined && list.some((other) => other.to === item.parent);
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
              child={nested(item, enabled)}
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
                  badge={{ count: 0, noun: '' }}
                  collapsed={collapsed}
                  child={nested(item, disabled)}
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
  badge: { count: badge, noun },
  collapsed,
  child = false,
  locked = false,
  onNavigate,
}: {
  readonly item: NavItem;
  readonly badge: Badge;
  readonly collapsed: boolean;
  /** Indented under its parent item (expanded sidebar only). */
  readonly child?: boolean;
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
        child && !collapsed && 'ml-5 h-8 pl-2.5 text-sm',
        // Locked items stay readable (≥ 4.5:1) and look like any active item once opened.
        locked && 'text-muted-foreground',
      )}
      activeProps={{ 'aria-current': 'page', className: 'active font-medium' }}
    >
      <Icon
        aria-hidden="true"
        className={cn(
          'shrink-0 text-muted-foreground transition-colors group-hover/nav:text-sidebar-accent-foreground group-[.active]/nav:text-sidebar-accent-foreground',
          collapsed ? 'size-5' : child ? 'size-4' : 'size-4.5',
          locked && 'opacity-70 group-[.active]/nav:opacity-100',
        )}
      />
      {!collapsed ? <span className="min-w-0 flex-1 truncate">{item.label}</span> : null}
      {!collapsed && locked ? (
        <Lock aria-hidden="true" className="size-3.5 shrink-0 text-subtle-foreground" />
      ) : null}
      {badge > 0 ? <span className="sr-only">{`, ${badge} ${noun}`}</span> : null}
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
            ? `${item.label} · ${badgeText} ${noun}`
            : item.label
      }
    >
      {link}
    </Hint>
  );
}
