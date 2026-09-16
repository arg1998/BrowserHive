/** @module dashboard/test/helpers/page-harness — render a page route inside the real provider tree (auth, confirm, router, socket, notifications) with a scripted fetch and a FakeSocket store */
import '../setup.ts';
import {
  type AnyRoute,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from '@tanstack/react-router';
import type { ComponentType } from 'react';
import { AuthProvider } from '@/app/providers/AuthProvider.tsx';
import { ConfirmProvider } from '@/app/providers/ConfirmProvider.tsx';
import { NotificationsProvider } from '@/app/providers/NotificationsProvider.tsx';
import { SocketProvider } from '@/app/providers/SocketProvider.tsx';
import { ToastStack } from '@/app/shell/ToastStack.tsx';
import type { FetchLike } from '@/lib/api/http.ts';
import { SocketStore } from '@/lib/ws/store.ts';
import { FakeSocket, FakeTimers } from './fake-socket.ts';
import { act, render, testQueryClient } from './render.tsx';

/** One recorded request. */
export interface RecordedRequest {
  readonly method: string;
  readonly path: string;
  readonly query: URLSearchParams;
  readonly body: unknown;
}

/** A scripted route: `METHOD /api/v1/path` (no query) → JSON body, status, or a function. */
export type FakeRoute =
  | unknown
  | ((request: RecordedRequest) => { readonly status?: number; readonly body: unknown } | unknown);

/** Build a JSON response. */
export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': status >= 400 ? 'application/problem+json' : 'application/json',
    },
  });
}

/** A problem+json error response body. */
export function problem(status: number, code: string, title = code) {
  return { status, body: { type: 'about:blank', title, status, code, retryable: 'never' } };
}

const ME = {
  principal: {
    subject: 'operator',
    kind: 'operator',
    display: 'admin',
    scopes: [],
    must_change_password: false,
  },
};

/** An empty collection envelope. */
export function envelope<T>(data: readonly T[], extra: Record<string, unknown> = {}) {
  return {
    data: [...data],
    page: { next_cursor: null, limit: 50, total: data.length },
    applied: { filters: {}, sort: { key: 'ts', dir: 'desc' as const } },
    meta: { now: 1_700_000_000_000 },
    ...extra,
  };
}

/** Scripted fetch: routes keyed by `METHOD path`; unknown routes 404 and are recorded. */
export function fakeFetch(routes: Record<string, FakeRoute>) {
  const requests: RecordedRequest[] = [];
  const fetchImpl: FetchLike = async (input, init) => {
    const url = new URL(String(input), 'http://localhost:9876');
    const method = (init?.method ?? 'GET').toUpperCase();
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
    const request = { method, path: url.pathname, query: url.searchParams, body };
    requests.push(request);
    if (url.pathname.endsWith('/auth/me')) return json(ME);
    const key = `${method} ${url.pathname.replace(/^\/api\/v1/, '')}`;
    if (!(key in routes)) return json(problem(404, 'NOT_FOUND').body, 404);
    const route = routes[key];
    const result: unknown = typeof route === 'function' ? await route(request) : route;
    if (
      typeof result === 'object' &&
      result !== null &&
      'body' in result &&
      'status' in result &&
      typeof result.status === 'number'
    ) {
      return json(result.body, result.status);
    }
    return json(result);
  };
  return { fetchImpl, requests };
}

/** Options. */
export interface PageHarnessOptions {
  readonly path: string;
  readonly component: ComponentType;
  readonly validateSearch?: (search: Record<string, unknown>) => Record<string, unknown>;
  readonly routes: Record<string, FakeRoute>;
  readonly url: string;
  /** Extra routes (e.g. a redirect route under test). */
  readonly extra?: (root: AnyRoute) => AnyRoute[];
}

/** Render a page; returns the router, sockets, recorded requests and helpers to push feed events. */
export function renderPage(options: PageHarnessOptions) {
  const sockets: FakeSocket[] = [];
  const timers = new FakeTimers();
  const { fetchImpl, requests } = fakeFetch(options.routes);
  const createStore = (storeOptions: ConstructorParameters<typeof SocketStore>[0]) =>
    new SocketStore({
      ...storeOptions,
      createSocket: (url, protocols) => {
        const socket = new FakeSocket(url, protocols);
        sockets.push(socket);
        return socket;
      },
      timers,
      clock: () => timers.now,
      random: () => 0,
    });
  const root = createRootRoute({
    component: () => (
      <SocketProvider createStore={createStore}>
        <NotificationsProvider>
          <Outlet />
          <ToastStack />
        </NotificationsProvider>
      </SocketProvider>
    ),
    staticData: { title: 'Test' },
  });
  const page = createRoute({
    getParentRoute: () => root,
    path: options.path,
    component: function PageUnderTest() {
      const Page = options.component;
      return <Page />;
    },
    ...(options.validateSearch !== undefined && { validateSearch: options.validateSearch }),
    staticData: { title: 'Page' },
  });
  const router = createRouter({
    routeTree: root.addChildren([page, ...(options.extra?.(root) ?? [])]),
    history: createMemoryHistory({ initialEntries: [options.url] }),
  });
  const client = testQueryClient();
  const view = render(
    <AuthProvider fetch={fetchImpl}>
      <ConfirmProvider>
        <RouterProvider router={router} />
      </ConfirmProvider>
    </AuthProvider>,
    { client },
  );
  let seq = 0;
  /** Open the socket (hello) once the provider created it. */
  const connect = () => {
    const socket = sockets[sockets.length - 1];
    if (socket === undefined) throw new Error('socket not created yet');
    act(() => socket.hello('e1', 0));
    return socket;
  };
  /** Deliver a feed event on `topic`. */
  const emit = (topic: string, payload: unknown) => {
    seq += 1;
    const socket = sockets[sockets.length - 1];
    act(() => socket?.receive({ v: 1, kind: 'event', seq, ts: seq, topic, payload }));
  };
  return { ...view, router, sockets, requests, client, connect, emit, timers };
}
