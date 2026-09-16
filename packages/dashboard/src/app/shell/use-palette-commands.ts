/** @module app/shell/use-palette-commands — palette entries: This page / Sessions (via `/search`) / Attention (pending) / Pages / Actions / Recent, plus the substring filter */

import { parseSessionId } from '@browserhive/contracts/ids';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { useCallback, useMemo } from 'react';
import { useApi, useAuth } from '@/app/providers/AuthProvider.tsx';
import { keys } from '@/lib/api/keys.ts';
import type { IconName } from '@/lib/icons.ts';
import { SESSION_STATE, type StatusEntry, sessionDisplayState } from '@/lib/status-registry.ts';
import { readStorageJson, writeStorageJson } from '@/lib/storage.ts';
import { useTheme } from '@/theme/ThemeProvider.tsx';
import type { PageAction } from './page-actions.tsx';
import { useSidebarPreference } from './sidebar-state.ts';
import { useNavItems } from './use-route-table.ts';

/** Palette section. */
export type PaletteGroup = 'Recent' | 'This page' | 'Sessions' | 'Attention' | 'Pages' | 'Actions';

/** One palette entry. */
export interface PaletteCommand {
  readonly id: string;
  readonly group: PaletteGroup;
  readonly label: string;
  readonly hint?: string;
  /** Rendered as a mono hint (ids). */
  readonly monoHint?: boolean;
  /** Entity state shown as a dot before the hint (sessions with the same slug differ by it). */
  readonly status?: StatusEntry;
  /** Entity time shown relative after the hint (last activity of a session). */
  readonly at?: number;
  readonly icon: IconName;
  readonly keywords: readonly string[];
  /** Entity results are already matched by the server: never filtered out client-side. */
  readonly serverMatched?: boolean;
  readonly run: () => void;
}

/** Group render order. */
export const PALETTE_GROUPS: readonly PaletteGroup[] = [
  'Recent',
  'This page',
  'Sessions',
  'Attention',
  'Pages',
  'Actions',
];

const RECENT_KEY = 'bh.palette.recent';
const RECENT_LIMIT = 5;

/** Substring match over label, hint and keywords. */
export function matchesQuery(
  command: Pick<PaletteCommand, 'label' | 'hint' | 'keywords'>,
  query: string,
): boolean {
  const q = query.trim().toLowerCase();
  if (q === '') return true;
  return [command.label, command.hint ?? '', ...command.keywords].some((s) =>
    s.toLowerCase().includes(q),
  );
}

/** Recent selections (localStorage). */
export function readRecent(): readonly string[] {
  return (
    readStorageJson<string[]>(RECENT_KEY, (raw) =>
      Array.isArray(raw) && raw.every((v) => typeof v === 'string') ? raw : null,
    ) ?? []
  );
}

/** Remember a selection; returns the new recent list. */
export function pushRecent(recent: readonly string[], id: string): readonly string[] {
  const next = [id, ...recent.filter((r) => r !== id)].slice(0, RECENT_LIMIT);
  writeStorageJson(RECENT_KEY, next);
  return next;
}

/** Commands for the current query plus whether an entity search is in flight. */
export function usePaletteCommands(
  open: boolean,
  debouncedQuery: string,
  pageActions: readonly PageAction[],
): { readonly commands: readonly PaletteCommand[]; readonly searching: boolean } {
  const navigate = useNavigate();
  const api = useApi();
  const { logout } = useAuth();
  const theme = useTheme();
  const [sidebar, setSidebar] = useSidebarPreference();
  const items = useNavItems();
  const search = useQuery({
    queryKey: keys.search(debouncedQuery),
    queryFn: () => api.search({ query: { q: debouncedQuery, limit: 6 } }),
    enabled: open && debouncedQuery.length >= 2,
    staleTime: 5_000,
    retry: false,
  });
  // Session rows with state and last activity, so several sessions sharing a slug are told apart
  //. `/search` only returns id + slug; it stays the fallback.
  const sessionList = useQuery({
    queryKey: keys.sessions.list({ palette: true, q: debouncedQuery, limit: 6 }),
    queryFn: () =>
      api.listSessions({
        query: { q: debouncedQuery, limit: 6, sort: 'last_activity_at', dir: 'desc' },
      }),
    enabled: open && debouncedQuery.length >= 2,
    staleTime: 5_000,
    retry: false,
  });
  const attentionQuery = {
    status: ['pending' as const],
    limit: 5,
    ...(debouncedQuery.length >= 2 && { q: debouncedQuery }),
  };
  const attention = useQuery({
    queryKey: keys.attention.list({ palette: true, ...attentionQuery }),
    queryFn: () => api.listAttention({ query: attentionQuery }),
    enabled: open,
    staleTime: 5_000,
    retry: false,
  });
  const go = useCallback((to: string) => () => void navigate({ to }), [navigate]);
  const commands = useMemo<readonly PaletteCommand[]>(() => {
    const here: PaletteCommand[] = pageActions.map((a) => ({
      id: `page-action:${a.id}`,
      group: 'This page',
      label: a.label,
      icon: a.icon,
      keywords: a.keywords ?? [],
      ...(a.hint !== undefined && { hint: a.hint }),
      run: a.run,
    }));
    const pages: PaletteCommand[] = items.map((item) => ({
      id: `page:${item.to}`,
      group: 'Pages',
      label: `Go to ${item.label}`,
      icon: item.icon,
      keywords: item.keywords,
      run: go(item.to),
    }));
    pages.push({
      id: 'page:/notifications',
      group: 'Pages',
      label: 'Go to Notifications',
      icon: 'notifications',
      keywords: ['bell', 'alerts', 'inbox'],
      run: go('/notifications'),
    });
    const sessions: PaletteCommand[] =
      sessionList.data !== undefined && sessionList.data.data.length > 0
        ? sessionList.data.data.map((s) => ({
            id: `session:${s.session_id}`,
            group: 'Sessions',
            label: s.slug,
            // The slug is the label; the suffix tells same-slug sessions apart.
            hint: parseSessionId(s.session_id)?.suffix ?? s.session_id,
            monoHint: true,
            status: SESSION_STATE[sessionDisplayState(s)],
            at: s.last_activity_at,
            icon: 'sessions',
            keywords: [s.session_id],
            serverMatched: true,
            run: go(`/sessions/${s.session_id}`),
          }))
        : (search.data?.sessions ?? []).map((s) => ({
            id: `session:${s.session_id}`,
            group: 'Sessions',
            label: s.slug,
            hint: s.session_id,
            monoHint: true,
            icon: 'sessions',
            keywords: [s.session_id],
            serverMatched: true,
            run: go(`/sessions/${s.session_id}`),
          }));
    const requests: PaletteCommand[] = (attention.data?.data ?? []).map((r) => ({
      id: `attention:${r.request_id}`,
      group: 'Attention',
      label: r.reason,
      hint: r.session_slug,
      icon: 'attention',
      keywords: [r.session_slug, r.session_id],
      serverMatched: debouncedQuery.length >= 2,
      run: go(`/attention`),
    }));
    const actions: PaletteCommand[] = [
      ...(['light', 'dark', 'system'] as const)
        .filter((p) => p !== theme.preference)
        .map(
          (p): PaletteCommand => ({
            id: `action:theme:${p}`,
            group: 'Actions',
            label: `Switch to ${p === 'system' ? 'system' : p} theme`,
            icon: p === 'dark' ? 'moon' : p === 'light' ? 'sun' : 'monitor',
            keywords: ['theme', 'appearance', 'dark', 'light', 'mode'],
            run: () => theme.set(p),
          }),
        ),
      {
        id: 'action:sidebar',
        group: 'Actions',
        label: sidebar === 'collapsed' ? 'Expand sidebar' : 'Collapse sidebar',
        icon: 'sidebar',
        keywords: ['navigation', 'rail', 'pin'],
        run: () => setSidebar(sidebar === 'collapsed' ? 'expanded' : 'collapsed'),
      },
      {
        id: 'action:password',
        group: 'Actions',
        label: 'Change password',
        icon: 'lock',
        keywords: ['account', 'security'],
        run: () => void navigate({ to: '/change-password', search: { voluntary: true } }),
      },
      {
        id: 'action:logout',
        group: 'Actions',
        label: 'Log out',
        icon: 'logout',
        keywords: ['sign out', 'account'],
        run: () => void logout(),
      },
    ];
    return [...here, ...sessions, ...requests, ...pages, ...actions];
  }, [
    items,
    search.data,
    sessionList.data,
    attention.data,
    pageActions,
    theme,
    sidebar,
    setSidebar,
    logout,
    go,
    navigate,
    debouncedQuery,
  ]);
  return { commands, searching: search.isFetching || sessionList.isFetching };
}
