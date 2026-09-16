/** @module app/shell/RouteError — route-level error surface rendered inside the shell (sidebar and topbar survive), reports to the client-error sink, Retry = `router.invalidate()` + reset */
import { type ErrorComponentProps, useRouter } from '@tanstack/react-router';
import { Component, type ErrorInfo, type ReactNode, useEffect } from 'react';
import { useClientErrorSink } from '@/app/providers/AuthProvider.tsx';
import { ErrorState } from '@/components/shared/ErrorState.tsx';
import { toAppError } from '@/lib/api/errors.ts';

/** Router `defaultErrorComponent` / route `errorComponent`. */
export function RouteError({ error, reset }: ErrorComponentProps) {
  const sink = useClientErrorSink();
  const router = useRouter();
  const appError = toAppError(error);
  const stack = error instanceof Error ? error.stack : undefined;
  const route = router.state.location.pathname;
  useEffect(() => {
    sink.report({
      message: appError.message,
      ...(stack !== undefined && { stack }),
      route,
    });
  }, [appError.message, stack, sink, route]);
  return (
    <div className="flex flex-1 flex-col">
      <ErrorState
        tier="page"
        error={appError}
        onRetry={() => {
          reset();
          void router.invalidate();
        }}
        escape={{ label: 'Go to Overview', to: '/overview' }}
      />
    </div>
  );
}

interface BoundaryProps {
  readonly children: ReactNode;
  /** What to render instead of the crashed widget (default: nothing, the shell keeps working). */
  readonly fallback?: ReactNode;
  readonly onError?: (error: Error, info: ErrorInfo) => void;
}

/** Tiny boundary for shell widgets (bell, account menu, palette): a crash hides the widget, never the app. */
export class WidgetBoundary extends Component<BoundaryProps, { readonly failed: boolean }> {
  override state = { failed: false };

  static getDerivedStateFromError(): { readonly failed: boolean } {
    return { failed: true };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    this.props.onError?.(error, info);
  }

  override render(): ReactNode {
    return this.state.failed ? (this.props.fallback ?? null) : this.props.children;
  }
}
