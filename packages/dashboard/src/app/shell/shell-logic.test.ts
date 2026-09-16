/** @module app/shell/shell-logic.test — sidebar pin resolution, vault nav gating, health pill state, already-here toasts, keyboard-map sections, palette ordering */
import { describe, expect, it } from 'bun:test';
import { isAlreadyAt } from '@/app/providers/NotificationsProvider.tsx';
import type { Shortcut } from '@/lib/keyboard.ts';
import { visibleCommands } from './CommandPalette.tsx';
import { healthState } from './HealthPill.tsx';
import { shortcutSections, TABLE_SHORTCUTS } from './KeyboardMap.tsx';
import { groupNavItems } from './SidebarNav.tsx';
import { parseSidebarPreference, resolveSidebar } from './sidebar-state.ts';
import type { PaletteCommand } from './use-palette-commands.ts';
import type { NavItem } from './use-route-table.ts';

const nav = (to: string, requires?: 'vault'): NavItem => ({
  id: to,
  to,
  label: to.slice(1),
  icon: 'overview',
  group: 'primary',
  order: 1,
  requires,
  keywords: [],
  key: undefined,
});

describe('sidebar', () => {
  it('pins at every width and defaults by width only without a stored preference', () => {
    expect(resolveSidebar('expanded', false)).toBe('expanded');
    expect(resolveSidebar('collapsed', true)).toBe('collapsed');
    expect(resolveSidebar(null, true)).toBe('expanded');
    expect(resolveSidebar(null, false)).toBe('collapsed');
    expect(parseSidebarPreference('rail')).toBeNull();
    expect(parseSidebarPreference('collapsed')).toBe('collapsed');
  });

  it('keeps vault items out of every group until /system answered', () => {
    const items = [nav('/overview'), nav('/vault', 'vault'), nav('/vault/log', 'vault')];
    expect(groupNavItems(items, null).enabled.map((i) => i.to)).toEqual(['/overview']);
    expect(groupNavItems(items, null).disabled).toEqual([]);
    expect(groupNavItems(items, false).disabled.map((i) => i.to)).toEqual(['/vault', '/vault/log']);
    expect(groupNavItems(items, true).enabled).toHaveLength(3);
  });
});

describe('topbar and toasts', () => {
  it('derives the health pill from socket state and REST freshness', () => {
    expect(healthState('connected', true)).toEqual({ label: 'Live', tone: 'success' });
    expect(healthState('connected', false).label).toBe('Degraded');
    expect(healthState('offline', true).tone).toBe('danger');
    expect(healthState('connecting', true).label).toBe('Connecting');
  });

  it('knows when the operator is already on a toast target', () => {
    expect(isAlreadyAt('/sessions/a-1', '/sessions/a-1')).toBe(true);
    expect(isAlreadyAt('/sessions/a-1/live', '/sessions/a-1')).toBe(true);
    expect(isAlreadyAt('/sessions/a-12', '/sessions/a-1')).toBe(false);
    expect(isAlreadyAt('/attention', '/sessions/a-1?tab=timeline')).toBe(false);
  });
});

describe('keyboard map', () => {
  it('lists real shortcuts, hides plumbing and orders General first', () => {
    const registered: Shortcut[] = [
      {
        id: 'filter.focus',
        combo: '/',
        description: 'x',
        scope: 'page',
        group: 'Page',
        handler: () => undefined,
      },
      {
        id: 'overlay.close',
        combo: 'escape',
        description: 'Close',
        scope: 'global',
        group: 'General',
        handler: () => undefined,
      },
      {
        id: 'keymap.open',
        combo: '?',
        description: 'Show keyboard shortcuts',
        scope: 'global',
        group: 'General',
        handler: () => undefined,
      },
      {
        id: 'session.live',
        combo: 'l',
        description: 'Toggle live view',
        scope: 'page',
        group: 'Session',
        handler: () => undefined,
      },
    ];
    const sections = shortcutSections(registered, { tables: true });
    expect(sections[0]?.[0]).toBe('General');
    const all = sections.flatMap(([, list]) => list.map((s) => s.id));
    expect(all).toContain('keymap.open');
    expect(all).toContain('session.live');
    // Esc is listed exactly once, whatever registers it.
    expect(all.filter((id) => id === 'overlay.close')).toHaveLength(1);
    // Registered minus the hidden Esc registration, plus the documented Esc, plus the table keys.
    expect(all.length).toBe(registered.length - 1 + 1 + TABLE_SHORTCUTS.length);
    // One row for j/k and the arrows.
    const move = sections.flatMap(([, list]) => list).find((s) => s.id === 'table.move');
    expect(move?.combos).toEqual([
      ['j', 'k'],
      ['arrowdown', 'arrowup'],
    ]);
    // No table on the page: no table group.
    const plain = shortcutSections(registered).map(([group]) => group);
    expect(plain).not.toContain('Lists and tables');
  });
});

describe('command palette', () => {
  const cmd = (
    id: string,
    group: PaletteCommand['group'],
    label: string,
    serverMatched = false,
  ): PaletteCommand => ({
    id,
    group,
    label,
    icon: 'overview',
    keywords: [],
    ...(serverMatched && { serverMatched }),
    run: () => undefined,
  });

  it('keeps server-matched entities, orders sections and shows recents only without a query', () => {
    const commands = [
      cmd('page:/logs', 'Pages', 'Go to Logs'),
      cmd('session:s-1', 'Sessions', 'checkout-flow', true),
      cmd('action:logout', 'Actions', 'Log out'),
    ];
    expect(visibleCommands(commands, 'chk', []).map((c) => c.id)).toEqual(['session:s-1']);
    expect(visibleCommands(commands, 'log', []).map((c) => c.id)).toEqual([
      'session:s-1',
      'page:/logs',
      'action:logout',
    ]);
    const idle = visibleCommands(commands, '', ['action:logout']);
    expect(idle[0]?.id).toBe('recent:action:logout');
    expect(idle[0]?.group).toBe('Recent');
  });
});
