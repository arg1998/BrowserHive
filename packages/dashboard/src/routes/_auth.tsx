/** @module routes/_auth — layout requiring `ready`: the auth gate renders the shell around the matched page */
import { createFileRoute, Outlet } from '@tanstack/react-router';
import { AuthGate } from '@/app/shell/AuthGate.tsx';

function AuthLayoutRoute() {
  return (
    <AuthGate>
      <Outlet />
    </AuthGate>
  );
}

/** Authenticated layout. */
export const Route = createFileRoute('/_auth')({
  component: AuthLayoutRoute,
  staticData: { title: 'BrowserHive' },
});
