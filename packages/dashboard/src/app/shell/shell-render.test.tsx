/** @module app/shell/shell-render.test — the account menu opens without crashing and a page crash renders inside the shell with a working Retry */
import { describe, expect, it } from 'bun:test';
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from '@tanstack/react-router';
import { AuthProvider } from '@/app/providers/AuthProvider.tsx';
import type { FetchLike } from '@/lib/api/http.ts';
import { act, fireEvent, render, screen, waitFor } from '../../../test/helpers/render.tsx';
import { PrincipalMenu } from './PrincipalMenu.tsx';
import { RouteError } from './RouteError.tsx';

const me: FetchLike = async () =>
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

function mount(page: () => React.ReactNode) {
  const root = createRootRoute({
    component: () => (
      <div>
        <nav aria-label="Shell nav">shell survives</nav>
        <PrincipalMenu onOpenKeyboardMap={() => undefined} />
        <Outlet />
      </div>
    ),
    staticData: { title: 'T' },
  });
  const child = createRoute({
    getParentRoute: () => root,
    path: '/',
    component: page,
    staticData: { title: 'Page' },
  });
  const router = createRouter({
    routeTree: root.addChildren([child]),
    history: createMemoryHistory({ initialEntries: ['/'] }),
    defaultErrorComponent: RouteError,
  });
  render(
    <AuthProvider fetch={me}>
      <RouterProvider router={router} />
    </AuthProvider>,
  );
  return router;
}

describe('shell', () => {
  it('opens the account menu with its label and items', async () => {
    mount(() => <p>page body</p>);
    const trigger = await screen.findByRole('button', { name: /Account:/ });
    await act(async () => {
      fireEvent.click(trigger);
    });
    expect(await screen.findByRole('menuitem', { name: /Log out/ })).toBeDefined();
    expect(screen.getByRole('menuitem', { name: /Keyboard shortcuts/ })).toBeDefined();
    expect(screen.queryByText(/Something broke/)).toBeNull();
  });

  it('renders a page crash inside the shell and retries it', async () => {
    let broken = true;
    mount(() => {
      if (broken) throw new TypeError("Cannot read properties of undefined (reading 'level')");
      return <p>recovered page</p>;
    });
    expect(await screen.findByText('Something broke in the dashboard')).toBeDefined();
    expect(screen.getByText('shell survives')).toBeDefined();
    expect(screen.queryByText('Network error')).toBeNull();
    expect(screen.getByRole('button', { name: 'Copy details' })).toBeDefined();
    broken = false;
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    });
    await waitFor(() => expect(screen.getByText('recovered page')).toBeDefined());
  });
});
