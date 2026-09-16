/** @module routes/_public — public layout: already-ready operators are sent to the app */
import { createFileRoute, Navigate, Outlet, useLocation } from '@tanstack/react-router';
import { useAuth } from '@/app/providers/AuthProvider.tsx';

function PublicGate() {
  const { state } = useAuth();
  const location = useLocation();
  const voluntary =
    location.pathname === '/change-password' && location.searchStr.includes('voluntary');
  if (state.status === 'ready' && !voluntary) return <Navigate to="/overview" replace />;
  if (state.status === 'change' && location.pathname !== '/change-password')
    return <Navigate to="/change-password" replace />;
  return <Outlet />;
}

/** Public layout. */
export const Route = createFileRoute('/_public')({
  component: PublicGate,
  staticData: { title: 'BrowserHive' },
});
