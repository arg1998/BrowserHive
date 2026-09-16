/** @module routes/__root — root route: last-resort error boundary (full page) and the 404, which renders inside the shell for signed-in operators */
import { createRootRouteWithContext, Outlet } from '@tanstack/react-router';
import type { RouterContext } from '@/app/router.tsx';
import { AuthGate } from '@/app/shell/AuthGate.tsx';
import { NotFoundPage } from '@/app/shell/NotFoundPage.tsx';
import { RouteError } from '@/app/shell/RouteError.tsx';

function RootError(props: Parameters<typeof RouteError>[0]) {
  return (
    <div className="flex min-h-dvh flex-col bg-background px-gutter">
      <RouteError {...props} />
    </div>
  );
}

function NotFound() {
  return (
    <AuthGate>
      <NotFoundPage />
    </AuthGate>
  );
}

/** Root. */
export const Route = createRootRouteWithContext<RouterContext>()({
  component: () => <Outlet />,
  errorComponent: RootError,
  notFoundComponent: NotFound,
  staticData: { title: 'BrowserHive' },
});
