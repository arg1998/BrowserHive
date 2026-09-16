/** @module app/shell/CommandPalette.test — combobox/listbox roles, aria-activedescendant, keyboard selection, substring matching */

import { describe, expect, it } from 'bun:test';
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router';
import { AuthProvider } from '@/app/providers/AuthProvider.tsx';
import type { FetchLike } from '@/lib/api/http.ts';
import { expectNoA11yViolations } from '../../../test/helpers/axe.ts';
import { act, fireEvent, render, screen, waitFor } from '../../../test/helpers/render.tsx';
import { CommandPalette, matchesQuery } from './CommandPalette.tsx';

function makeRouter() {
  const root = createRootRoute({
    component: () => <CommandPalette open onOpenChange={() => undefined} />,
    staticData: { title: 'Test' },
  });
  const overview = createRoute({
    getParentRoute: () => root,
    path: '/overview',
    component: () => null,
    staticData: {
      title: 'Overview',
      nav: { label: 'Overview', icon: 'overview', group: 'primary', order: 1 },
      palette: { keywords: ['home'] },
    },
  });
  const sessions = createRoute({
    getParentRoute: () => root,
    path: '/sessions',
    component: () => null,
    staticData: {
      title: 'Sessions',
      nav: { label: 'Sessions', icon: 'sessions', group: 'primary', order: 2 },
      palette: { keywords: ['browsers'] },
    },
  });
  return createRouter({
    routeTree: root.addChildren([overview, sessions]),
    history: createMemoryHistory({ initialEntries: ['/overview'] }),
  });
}

describe('CommandPalette', () => {
  it('matches labels, hints and keywords by substring', () => {
    const command = { label: 'Go to Sessions', hint: 'list', keywords: ['browsers'] };
    expect(matchesQuery(command, 'sess')).toBe(true);
    expect(matchesQuery(command, 'BROW')).toBe(true);
    expect(matchesQuery(command, 'vault')).toBe(false);
    expect(matchesQuery(command, '')).toBe(true);
  });

  it('exposes combobox + listbox roles and moves the active option with arrows', async () => {
    const fetchImpl: FetchLike = async () =>
      new Response(
        JSON.stringify({
          principal: {
            subject: 'p',
            kind: 'operator',
            display: 'admin',
            scopes: [],
            must_change_password: false,
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    const router = makeRouter();
    const { container } = render(
      <AuthProvider fetch={fetchImpl}>
        <RouterProvider router={router} />
      </AuthProvider>,
    );
    const input = await screen.findByRole('combobox');
    const listbox = screen.getByRole('listbox');
    expect(input.getAttribute('aria-controls')).toBe(listbox.id);
    const options = await screen.findAllByRole('option');
    expect(options.length).toBeGreaterThanOrEqual(4);
    expect(input.getAttribute('aria-activedescendant') ?? '').toBe(options[0]?.id ?? '');
    await act(async () => {
      fireEvent.keyDown(input, { key: 'ArrowDown' });
    });
    await waitFor(() =>
      expect(input.getAttribute('aria-activedescendant') ?? '').toBe(options[1]?.id ?? ''),
    );
    expect(options[1]?.getAttribute('aria-selected')).toBe('true');
    await act(async () => {
      fireEvent.change(input, { target: { value: 'browsers' } });
    });
    await waitFor(() => expect(screen.getAllByRole('option').length).toBe(1));
    expect(screen.getByRole('option').textContent).toContain('Go to Sessions');
    await expectNoA11yViolations(container.ownerDocument.body);
  });
});
