/** @module components/shared/DataPanel — the only way a widget renders loading/empty/error: query → skeleton (400 ms delay) | retrying notice | error | empty | children(data), plus a stale-data notice when a refetch fails */
import type { UseQueryResult } from '@tanstack/react-query';
import { Component, type ErrorInfo, type ReactNode, useEffect, useState } from 'react';
import { Button } from '@/components/ui/button.tsx';
import { Spinner } from '@/components/ui/spinner.tsx';
import { type AppError, toAppError } from '@/lib/api/errors.ts';
import { ICONS } from '@/lib/icons.ts';
import { ErrorState } from './ErrorState.tsx';

/** Props. */
export interface DataPanelProps<T> {
  readonly query: UseQueryResult<T, unknown>;
  readonly skeleton: ReactNode;
  /** Empty when `isEmpty(data)`; defaults to empty arrays / `{data: []}` envelopes. */
  readonly isEmpty?: (data: T) => boolean;
  readonly empty: ReactNode;
  readonly children: (data: T) => ReactNode;
  /** Report render errors (widget-level boundary). */
  readonly onError?: (error: Error, info: ErrorInfo) => void;
  /** Error surface variant (`panel` when the widget has no card of its own). */
  readonly errorVariant?: 'inline' | 'panel';
}

/** Show a skeleton only after `delayMs` so quick loads never flash. */
export function useDelayedFlag(active: boolean, delayMs = 400): boolean {
  const [shown, setShown] = useState(false);
  useEffect(() => {
    if (!active) {
      setShown(false);
      return undefined;
    }
    const timer = setTimeout(() => setShown(true), delayMs);
    return () => clearTimeout(timer);
  }, [active, delayMs]);
  return active && shown;
}

function defaultIsEmpty(data: unknown): boolean {
  if (Array.isArray(data)) return data.length === 0;
  if (typeof data === 'object' && data !== null && 'data' in data) {
    const inner = (data as { data: unknown }).data;
    return Array.isArray(inner) && inner.length === 0;
  }
  return false;
}

/** What the panel shows for a query state (pure; exported for tests). */
export function panelPhase(
  query: Pick<UseQueryResult<unknown, unknown>, 'isPending' | 'isError' | 'failureCount' | 'data'>,
): 'loading' | 'retrying' | 'error' | 'stale-error' | 'data' {
  if (query.isPending && !query.isError) return query.failureCount > 0 ? 'retrying' : 'loading';
  if (query.isError) return query.data === undefined ? 'error' : 'stale-error';
  return 'data';
}

interface BoundaryProps {
  readonly children: ReactNode;
  readonly onError?: (error: Error, info: ErrorInfo) => void;
  readonly resetKey: unknown;
}
interface BoundaryState {
  readonly error: AppError | null;
  readonly resetKey: unknown;
}

/** Widget-level error boundary: a render bug in one widget never takes down the page. */
export class PanelBoundary extends Component<BoundaryProps, BoundaryState> {
  override state: BoundaryState = { error: null, resetKey: undefined };

  static getDerivedStateFromError(error: unknown): Partial<BoundaryState> {
    return { error: toAppError(error) };
  }

  static getDerivedStateFromProps(
    props: BoundaryProps,
    state: BoundaryState,
  ): Partial<BoundaryState> | null {
    return props.resetKey !== state.resetKey ? { error: null, resetKey: props.resetKey } : null;
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    this.props.onError?.(error, info);
  }

  override render(): ReactNode {
    if (this.state.error !== null) {
      return (
        <ErrorState
          tier="region"
          error={this.state.error}
          onRetry={() => this.setState({ error: null })}
        />
      );
    }
    return this.props.children;
  }
}

/** Data panel. */
export function DataPanel<T>({
  query,
  skeleton,
  isEmpty = defaultIsEmpty,
  empty,
  children,
  onError,
  errorVariant = 'inline',
}: DataPanelProps<T>) {
  const phase = panelPhase(query);
  const showSkeleton = useDelayedFlag(phase === 'loading');
  switch (phase) {
    case 'loading':
      return showSkeleton ? skeleton : null;
    case 'retrying': {
      const last = query.error ?? query.failureReason;
      return (
        <div className="relative">
          <div aria-hidden="true" className="opacity-60">
            {skeleton}
          </div>
          <div
            role="status"
            className="absolute inset-x-0 top-10 mx-auto flex w-fit items-center gap-2 rounded-full border bg-popover px-3 py-1.5 text-sm text-muted-foreground shadow-popover"
          >
            <Spinner className="size-3.5" />
            {last !== null && last !== undefined
              ? `${toAppError(last).title}: retrying (attempt ${query.failureCount + 1})…`
              : 'Retrying…'}
          </div>
        </div>
      );
    }
    case 'error':
      return (
        <ErrorState
          tier="region"
          variant={errorVariant}
          error={toAppError(query.error)}
          onRetry={() => void query.refetch()}
        />
      );
    default: {
      const data = query.data as T;
      const body = isEmpty(data) ? (
        empty
      ) : (
        <PanelBoundary resetKey={query.dataUpdatedAt} {...(onError !== undefined && { onError })}>
          {children(data)}
        </PanelBoundary>
      );
      if (phase !== 'stale-error') return body;
      const Warn = ICONS.warn;
      return (
        <div className="flex flex-col gap-3">
          <div
            role="status"
            className="flex flex-wrap items-center gap-2 rounded-lg bg-warn-bg px-3 py-2 text-sm text-warn-text"
          >
            <Warn aria-hidden="true" className="size-4 shrink-0" />
            <span className="min-w-0 flex-1">
              Showing earlier data: {toAppError(query.error).title.toLowerCase()}.
            </span>
            <Button type="button" variant="ghost" size="xs" onClick={() => void query.refetch()}>
              Retry
            </Button>
          </div>
          {body}
        </div>
      );
    }
  }
}
