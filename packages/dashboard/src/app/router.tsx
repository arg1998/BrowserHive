/** @module app/router — `createRouter(routeTree)` with `{ queryClient, auth }` context and the `staticData` route-table contract (spec 04 §6.2) */
import type { QueryClient } from '@tanstack/react-query';
import { createRouter } from '@tanstack/react-router';
import type { ReactNode } from 'react';
import type { IconName } from '@/lib/icons.ts';
import { routeTree } from '@/routeTree.gen.ts';
import type { AuthStatus } from './providers/auth-machine.ts';
import { NotificationsProvider } from './providers/NotificationsProvider.tsx';
import { SocketProvider } from './providers/SocketProvider.tsx';
import { parseSearch, stringifySearch } from './search-params.ts';
import { RouteError } from './shell/RouteError.tsx';

/** Sidebar groups. */
export type NavGroup = 'primary' | 'secondary';

/** Route table entry (spec 04 §6.2). Every route file exports it as `staticData`. */
export interface RouteStaticData {
  readonly title: string;
  readonly nav?: {
    readonly label: string;
    readonly icon: IconName;
    readonly group: NavGroup;
    readonly order: number;
    /** Single-key shortcut in the palette / `g` sequences (informational). */
    readonly key?: string;
  };
  /** Object pages show a breadcrumb instead of the title. */
  readonly crumb?: (params: Record<string, string>) => string;
  /** Capability the page needs; when off in `/system`, the item is greyed with a lock glyph. */
  readonly requires?: 'vault' | 'admin';
  readonly palette?: { readonly keywords: readonly string[] };
}

declare module '@tanstack/react-router' {
  interface StaticDataRouteOption extends RouteStaticData {}
  interface Register {
    router: ReturnType<typeof createAppRouter>;
  }
}

/** What routes see in `context`. */
export interface RouterContext {
  readonly queryClient: QueryClient;
  readonly auth: { readonly status: AuthStatus };
}

/** Providers that need router hooks (`useNavigate`) mount inside the router. */
function InnerWrap({ children }: { readonly children: ReactNode }) {
  return (
    <SocketProvider>
      <NotificationsProvider>{children}</NotificationsProvider>
    </SocketProvider>
  );
}

/** Build the router. `context.auth` is refreshed by `RouterProvider` on every auth change. */
export function createAppRouter(context: RouterContext) {
  return createRouter({
    routeTree,
    context,
    InnerWrap,
    // Every route gets its own boundary, rendered inside its parent's outlet, so a page crash
    // keeps the sidebar and topbar.
    defaultErrorComponent: RouteError,
    // Readable, shareable URLs: `?level=warn,error`, not `?level=%5B%22warn%22%5D`.
    stringifySearch,
    parseSearch,
    defaultPreload: 'intent',
    defaultPreloadStaleTime: 0,
    scrollRestoration: true,
    defaultStructuralSharing: true,
  });
}
