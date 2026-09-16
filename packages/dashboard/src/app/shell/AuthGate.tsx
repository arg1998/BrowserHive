/** @module app/shell/AuthGate — renders `children` inside the shell once the operator is known; a failing session check never replaces a known shell, redirects on sign-out */
import { Navigate } from '@tanstack/react-router';
import type { ReactNode } from 'react';
import { useAuth } from '@/app/providers/AuthProvider.tsx';
import { ErrorState } from '@/components/shared/ErrorState.tsx';
import { Spinner } from '@/components/ui/spinner.tsx';
import { AuthLayout } from '@/features/auth/AuthLayout.tsx';
import { clientError } from '@/lib/api/errors.ts';
import { AppShell } from './AppShell.tsx';
import { AuthRetryLine } from './AuthRetryNotice.tsx';

/** Auth gate. */
export function AuthGate({ children }: { readonly children: ReactNode }) {
  const { state, retry } = useAuth();
  switch (state.status) {
    case 'ready':
      return <AppShell>{children}</AppShell>;
    case 'login':
      return <Navigate to="/login" replace />;
    case 'change':
      return <Navigate to="/change-password" replace />;
    case 'error':
      // Only reached with nobody known and a non-transient failure (a contract mismatch or a bug).
      return (
        <AuthLayout>
          <ErrorState
            tier="page"
            title="Couldn't check your session"
            error={state.error ?? clientError(new Error('The session check failed.'))}
            onRetry={retry}
            className="px-0 py-2"
          />
        </AuthLayout>
      );
    default:
      return (
        <div className="flex min-h-dvh flex-col items-center justify-center gap-6 bg-background px-gutter">
          <div role="status" className="flex items-center gap-2.5 text-base text-muted-foreground">
            <Spinner /> Checking your session…
          </div>
          <AuthRetryLine />
        </div>
      );
  }
}
