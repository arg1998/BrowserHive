/** @module features/notifications/NotificationsPage.test — optimistic mark read / dismiss with rollback + error toast, unread count in sync, read/type filters in URL and request, dismiss-all confirm, day grouping, preferences save preserving unknown keys, axe clean */

import { describe, expect, it } from 'bun:test';
import type { Notification } from '@browserhive/contracts/http';
import { NOW, notification } from '../../../test/fixtures/ops.ts';
import { expectNoA11yViolations } from '../../../test/helpers/axe.ts';
import {
  envelope,
  problem,
  type RecordedRequest,
  renderPage,
} from '../../../test/helpers/page-harness.tsx';
import { fireEvent, screen, waitFor, within } from '../../../test/helpers/render.tsx';
import { mergePreferences } from './components/PreferencesForm.tsx';
import { groupByDay, NotificationsPage, visibleNotifications } from './NotificationsPage.tsx';
import { notificationMeta } from './notification-meta.ts';
import { notificationsSearch } from './search.ts';

interface ServerOptions {
  readonly failWrites?: boolean;
  /** Resolves pending writes when called (to observe the optimistic state). */
  readonly gate?: Promise<void>;
}

function mount(url = '/notifications', options: ServerOptions = {}) {
  const rows: Notification[] = [
    notification(1),
    notification(2, { type: 'vault', title: 'Vault fill awaiting confirm', target: '/vault' }),
  ];
  const write = (patch: (n: Notification) => Notification) => async (req: RecordedRequest) => {
    await options.gate;
    if (options.failWrites === true) return problem(500, 'INTERNAL_ERROR', 'Internal error');
    const id = req.path.split('/')[4];
    const index = rows.findIndex((n) => n.notification_id === id);
    const current = rows[index];
    if (current !== undefined) rows[index] = patch(current);
    return { ok: true };
  };
  const view = renderPage({
    path: '/notifications',
    component: NotificationsPage,
    validateSearch: (s) => notificationsSearch.parse(s),
    routes: {
      'GET /notifications': (req: RecordedRequest) => {
        const visible = rows.filter((n) => n.dismissed_at === null);
        const read = req.query.get('read');
        const data = visible.filter((n) =>
          read === 'unread' ? n.read_at === null : read === 'read' ? n.read_at !== null : true,
        );
        return envelope(data, { unread_count: visible.filter((n) => n.read_at === null).length });
      },
      [`POST /notifications/${notification(1).notification_id}/read`]: write((n) => ({
        ...n,
        read_at: NOW,
      })),
      [`DELETE /notifications/${notification(1).notification_id}`]: write((n) => ({
        ...n,
        dismissed_at: NOW,
      })),
      'POST /notifications/dismiss-all': () => {
        for (const [i, n] of rows.entries()) rows[i] = { ...n, dismissed_at: NOW };
        return { ok: true, updated: rows.length };
      },
      'GET /me/preferences': {
        preferences: { sidebar: 'expanded', saved_views: [] },
        updated_at: null,
      },
      'PUT /me/preferences': { ok: true, updated_at: NOW },
    },
    url,
  });
  return Object.assign(view, { rows });
}

/**
 * Poll with real timers. RTL's `waitFor` stalls in happy-dom while a mutation request is held
 * open, so the optimistic-state test polls explicitly.
 */
async function poll(check: () => boolean, timeoutMs = 2000): Promise<void> {
  const started = performance.now();
  while (!check()) {
    if (performance.now() - started > timeoutMs) throw new Error('poll timed out');
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

const row = (title: string) => {
  const li = screen.getByText(title).closest('li');
  if (li === null) throw new Error(`row ${title} missing`);
  return li;
};

describe('notifications helpers', () => {
  it('groups by day and hides dismissed rows', () => {
    const groups = groupByDay(
      [
        notification(1),
        notification(2, { dismissed_at: NOW }),
        notification(3, { created_at: NOW - 86_400_000, updated_at: NOW - 86_400_000 }),
      ],
      NOW,
    );
    expect(groups.map(([day, list]) => [day, list.length])).toEqual([
      ['Today', 1],
      ['Yesterday', 1],
    ]);
  });

  it('names the session once and orders folded groups by their latest occurrence', () => {
    const attention = notification(4, {
      type: 'attention',
      title: 'Attention requested',
      session_id: 'shop-a1b2c3d4' as Notification['session_id'],
      session_slug: 'shop',
    });
    expect(notificationMeta(attention)).toEqual(['shop']);
    const group = notification(5, {
      title: 'shop · 12 tool errors',
      session_id: 'shop-a1b2c3d4' as Notification['session_id'],
      session_slug: 'shop',
      count: 12,
      updated_at: NOW,
    });
    // The grouped title already leads with the slug: the meta line only says when it started.
    expect(notificationMeta(group)).toEqual([expect.stringMatching(/^first /)]);
    expect(visibleNotifications([notification(1), group]).map((n) => n.title)).toEqual([
      'shop · 12 tool errors',
      'Tool error · navigate 1',
    ]);
  });

  it('keeps preference keys the form does not edit', () => {
    const merged = mergePreferences(
      { saved_views: [], page_defaults: { sessions: { ps: 50 } } },
      { toasts: false, types: ['error'] },
    );
    expect(merged).toEqual({
      saved_views: [],
      page_defaults: { sessions: { ps: 50 } },
      notifications: { toasts: false, types: ['error'] },
    });
  });
});

describe('NotificationsPage', () => {
  it('marks read optimistically and keeps the unread count in sync', async () => {
    let released = false;
    const gate = new Promise<void>((resolve) => {
      setTimeout(() => {
        released = true;
        resolve();
      }, 400);
    });
    const view = mount('/notifications', { gate });
    await screen.findByText('Tool error · navigate 1');
    await screen.findByText('2 unread');
    fireEvent.click(
      within(row('Tool error · navigate 1')).getByRole('button', { name: /^Mark read/ }),
    );
    // Optimistic: the action disappears and the count drops while the server is still holding the write.
    await poll(
      () =>
        within(row('Tool error · navigate 1')).queryByRole('button', { name: /^Mark read/ }) ===
          null && screen.queryByText('1 unread') !== null,
    );
    expect(released).toBe(false);
    await poll(() => released && view.requests.some((r) => r.method === 'POST'));
    await poll(() => screen.queryByText('1 unread') !== null);
    await expectNoA11yViolations(view.container);
  });

  it('rolls back a failed dismiss and shows the error code', async () => {
    mount('/notifications', { failWrites: true });
    await screen.findByText('Tool error · navigate 1');
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss Tool error · navigate 1' }));
    expect((await screen.findAllByText('Could not dismiss')).length).toBeGreaterThan(0);
    expect(screen.getByText('Tool error · navigate 1')).toBeTruthy();
    expect((await screen.findAllByText('INTERNAL_ERROR')).length).toBeGreaterThan(0);
  });

  it('rolls back a failed mark read', async () => {
    mount('/notifications', { failWrites: true });
    await screen.findByText('2 unread');
    fireEvent.click(
      within(row('Tool error · navigate 1')).getByRole('button', { name: /^Mark read/ }),
    );
    expect((await screen.findAllByText('Could not mark as read')).length).toBeGreaterThan(0);
    await waitFor(() =>
      expect(
        within(row('Tool error · navigate 1')).getByRole('button', { name: /^Mark read/ }),
      ).toBeTruthy(),
    );
    await screen.findByText('2 unread');
  });

  it('writes read/type filters to the URL and the request', async () => {
    const view = mount();
    await screen.findByText('Tool error · navigate 1');
    fireEvent.click(
      within(screen.getByRole('group', { name: 'Show' })).getByRole('button', {
        name: 'Unread',
      }),
    );
    await waitFor(() =>
      expect(view.router.state.location.search).toMatchObject({ read: 'unread' }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Vault' }));
    await waitFor(() =>
      expect(view.router.state.location.search).toMatchObject({ type: ['vault'] }),
    );
    await waitFor(() => {
      const last = view.requests.filter((r) => r.path === '/api/v1/notifications').at(-1);
      expect(last?.query.get('type')).toBe('vault');
    });
    const review = screen.getByRole('link', { name: 'Review: Vault fill awaiting confirm' });
    expect(review.getAttribute('href')).toBe('/vault');
  });

  it('holds live notifications behind a pill while the list is being read', async () => {
    const view = mount();
    await screen.findByText('Tool error · navigate 1');
    await waitFor(() => expect(view.sockets.length).toBe(1));
    view.connect();
    fireEvent.pointerOver(screen.getByText('Tool error · navigate 1'));
    const fresh = notification(0, {
      title: 'Attention requested',
      type: 'attention',
      session_id: 'shop-a1b2c3d4' as Notification['session_id'],
      session_slug: 'shop',
      created_at: NOW + 1000,
      updated_at: NOW + 1000,
    });
    view.rows.unshift(fresh);
    view.emit('notifications', { type: 'notification.created', notification: fresh });
    const pill = await screen.findByRole('button', { name: /1 new notification/ });
    // The rows being read do not move: the new one waits behind the pill.
    expect(screen.queryByText('Attention requested')).toBeNull();
    fireEvent.click(pill);
    await screen.findByText('Attention requested');
    expect(screen.queryByRole('button', { name: /new notification/ })).toBeNull();
  });

  it('confirms Dismiss all and saves preferences', async () => {
    const view = mount();
    await screen.findByText('Tool error · navigate 1');
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss all' }));
    const dialog = await screen.findByRole('alertdialog', {}, { timeout: 3000 });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Dismiss all' }));
    await screen.findByText('Nothing here');

    const save = await screen.findByRole('button', { name: 'Save preferences' });
    expect((save as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole('switch'));
    await waitFor(() => expect((save as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(save);
    await waitFor(() => {
      const put = view.requests.find((r) => r.method === 'PUT');
      expect(put?.body).toMatchObject({
        preferences: { saved_views: [], notifications: { toasts: false } },
      });
    });
  });
});
