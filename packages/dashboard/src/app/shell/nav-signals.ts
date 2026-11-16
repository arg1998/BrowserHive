/** @module app/shell/nav-signals — what the sidebar needs besides the route table: badge counts (open attention, vault confirms, template sites that need a sign-in), which capabilities are on (vault, templates, site packs) and the pure grouping into enabled and "Not enabled" items */
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useApi } from '@/app/providers/AuthProvider.tsx';
import { useTopic } from '@/app/providers/SocketProvider.tsx';
import { TEMPLATES_TOPIC } from '@/features/templates/live.ts';
import { keys } from '@/lib/api/keys.ts';
import type { NavItem } from './use-route-table.ts';

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
