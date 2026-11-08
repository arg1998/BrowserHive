/** @module features/saved-logins/SavedLoginsPage.test — the list (kinds, owners, sizes, relative time, source session link or "deleted"), empty state, search, client-side sort, the confirmed delete naming owner and name, live refetch on `auth_state.changed`, axe clean */

import { describe, expect, it } from 'bun:test';
import type { AuthStateRow } from '@browserhive/contracts/http';
import { NOW } from '../../../test/fixtures/ops.ts';
import { expectNoA11yViolations } from '../../../test/helpers/axe.ts';
import { renderPage } from '../../../test/helpers/page-harness.tsx';
import { act, fireEvent, screen, waitFor, within } from '../../../test/helpers/render.tsx';
import { viewOf } from './api.ts';
import { SavedLoginsPage } from './SavedLoginsPage.tsx';
import { savedLoginsSearch } from './search.ts';

function row(overrides: Partial<AuthStateRow>): AuthStateRow {
  return {
    name: 'work',
    kind: 'storage',
    owner: 'local',
    size: 2_048,
    saved_at: NOW - 3 * 86_400_000,
    source_session_id: 'shop-0000000a',
    source_session_slug: 'shop',
    ...overrides,
  };
}

const ROWS: AuthStateRow[] = [
  row({ name: 'github', owner: 'alice', kind: 'profile', size: 5_242_880, saved_at: NOW - 60_000 }),
  row({}),
  row({
    name: 'mail',
    owner: 'bob',
    saved_at: NOW - 47 * 86_400_000,
    source_session_id: 'gone-0000000c',
    source_session_slug: null,
  }),
];

function mount(rows: AuthStateRow[] = ROWS, url = '/saved-logins') {
  const server = { rows: [...rows], lists: 0 };
  const view = renderPage({
    path: '/saved-logins',
    component: SavedLoginsPage,
    validateSearch: (s) => savedLoginsSearch.parse(s),
    routes: {
      'GET /auth-states': () => {
        server.lists += 1;
        return { data: server.rows, now: NOW };
      },
      'DELETE /auth-states/bob/mail': () => {
        const deleted = server.rows.find((r) => r.owner === 'bob' && r.name === 'mail');
        server.rows = server.rows.filter((r) => r !== deleted);
        return { ok: true, deleted };
      },
    },
    url,
  });
  return { ...view, server };
}

describe('saved logins view', () => {
  it('filters by name, owner or session, sorts in the browser and pages', () => {
    const base = { page: 1, ps: 25 as const, sort: undefined, dir: undefined, q: undefined };
    expect(viewOf(ROWS, { ...base, owner: undefined }).rows.map((r) => r.name)).toEqual([
      'github',
      'work',
      'mail',
    ]);
    expect(viewOf(ROWS, { ...base, owner: undefined, q: 'BOB' }).rows.map((r) => r.name)).toEqual([
      'mail',
    ]);
    expect(viewOf(ROWS, { ...base, owner: 'alice' }).total).toBe(1);
    expect(
      viewOf(ROWS, { ...base, owner: undefined, sort: 'size', dir: 'asc' }).rows.map((r) => r.name),
    ).toEqual(['mail', 'work', 'github']);
    expect(viewOf(ROWS, { ...base, owner: undefined, q: 'gone' }).total).toBe(1);
  });
});

describe('SavedLoginsPage', () => {
  it('lists every principal’s saved logins with kind, owner, size, age and source session', async () => {
    const view = mount();
    const table = await screen.findByRole('region', { name: 'Saved logins' });
    expect(within(table).getByText('Full profile')).toBeTruthy();
    expect(within(table).getAllByText('Cookies & storage')).toHaveLength(2);
    expect(within(table).getByText('alice')).toBeTruthy();
    expect(within(table).getByText('5.0 MB')).toBeTruthy();
    expect(within(table).getByText('47d ago')).toBeTruthy();
    // A source session that still exists is a link to its page; a deleted one says so.
    const link = within(table).getAllByRole('link', { name: 'shop' })[0] as HTMLAnchorElement;
    expect(link.getAttribute('href')).toBe('/sessions/shop-0000000a');
    expect(within(table).getByText('· deleted')).toBeTruthy();
    expect(screen.getByText(/3 saved logins/)).toBeTruthy();
    await expectNoA11yViolations(view.container);
  });

  it('shows the empty state when nothing is saved', async () => {
    const view = mount([]);
    expect(await screen.findByText('No saved logins')).toBeTruthy();
    expect(screen.queryByRole('region', { name: 'Saved logins' })).toBeNull();
    await expectNoA11yViolations(view.container);
  });

  it('deletes only after a confirmation that names the owner and the name', async () => {
    const view = mount();
    await screen.findByRole('region', { name: 'Saved logins' });
    await act(async () => {
      fireEvent.click(
        screen.getAllByRole('button', { name: 'Delete saved login mail of bob' })[0] as HTMLElement,
      );
    });
    const dialog = await screen.findByRole('alertdialog');
    expect(within(dialog).getByText('Delete saved login mail?')).toBeTruthy();
    expect(within(dialog).getByText(/Owner: bob\./)).toBeTruthy();
    expect(
      within(dialog).getByText(/Sessions already restored from it keep running\./),
    ).toBeTruthy();
    expect(view.requests.some((r) => r.method === 'DELETE')).toBe(false);
    await act(async () => {
      fireEvent.click(within(dialog).getByRole('button', { name: 'Delete' }));
    });
    await waitFor(() =>
      expect(
        view.requests.some(
          (r) => r.method === 'DELETE' && r.path === '/api/v1/auth-states/bob/mail',
        ),
      ).toBe(true),
    );
    expect((await screen.findAllByText('Saved login mail deleted')).length).toBeGreaterThan(0);
    await waitFor(() => expect(screen.queryAllByText('mail')).toHaveLength(0));
  });

  it('refetches when an agent saves or deletes a login (auth-states topic)', async () => {
    const view = mount();
    await screen.findByRole('region', { name: 'Saved logins' });
    await waitFor(() => expect(view.sockets.length).toBe(1));
    const before = view.server.lists;
    view.server.rows = [...view.server.rows, row({ name: 'fresh', owner: 'carol' })];
    act(() => {
      view.connect();
      view.emit('auth-states', {
        type: 'auth_state.changed',
        owner: 'carol',
        name: 'fresh',
        action: 'saved',
      });
    });
    await waitFor(() => expect(view.server.lists).toBeGreaterThan(before));
    expect((await screen.findAllByText('fresh')).length).toBeGreaterThan(0);
  });
});
