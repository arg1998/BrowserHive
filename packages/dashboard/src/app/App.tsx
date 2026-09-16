/** @module app/App — provider composition only (spec 04 §3) */

import { useQueryClient } from '@tanstack/react-query';
import { RouterProvider } from '@tanstack/react-router';
import { useMemo, useState } from 'react';
import { TooltipProvider } from '@/components/ui/tooltip.tsx';
import { ThemeProvider } from '@/theme/ThemeProvider.tsx';
import { AuthProvider, useAuth } from './providers/AuthProvider.tsx';
import { ConfirmProvider } from './providers/ConfirmProvider.tsx';
import { KeyboardProvider } from './providers/KeyboardProvider.tsx';
import { QueryProvider } from './providers/QueryProvider.tsx';
import { ToastProvider } from './providers/ToastProvider.tsx';
import { createAppRouter } from './router.tsx';

/** Creates the router once and feeds it the live auth status. */
function AppRouter() {
  const queryClient = useQueryClient();
  const { state } = useAuth();
  const [router] = useState(() => createAppRouter({ queryClient, auth: { status: state.status } }));
  const context = useMemo(
    () => ({ queryClient, auth: { status: state.status } }),
    [queryClient, state.status],
  );
  return <RouterProvider router={router} context={context} />;
}

/** The dashboard. */
export function App() {
  return (
    <ThemeProvider>
      <ToastProvider>
        <QueryProvider>
          <KeyboardProvider>
            <AuthProvider>
              <ConfirmProvider>
                <TooltipProvider>
                  <AppRouter />
                </TooltipProvider>
              </ConfirmProvider>
            </AuthProvider>
          </KeyboardProvider>
        </QueryProvider>
      </ToastProvider>
    </ThemeProvider>
  );
}
