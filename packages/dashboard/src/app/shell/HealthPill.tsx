/** @module app/shell/HealthPill — connection pill: realtime socket state + REST freshness; a real button opening a details popover, reachable on touch and keyboard */
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { useSocketState } from '@/app/providers/SocketProvider.tsx';
import { Button } from '@/components/ui/button.tsx';
import {
  Popover,
  PopoverContent,
  PopoverHeader,
  PopoverTitle,
  PopoverTrigger,
} from '@/components/ui/popover.tsx';
import { useServerClock } from '@/lib/server-now.ts';
import { cn } from '@/lib/utils.ts';

/** REST is healthy when any query succeeded in the last 30 s. */
const REST_FRESH_MS = 30_000;

/** Text for the offline reason. */
export function offlineReasonLabel(reason: string | null): string {
  switch (reason) {
    case 'unauthorized':
      return 'unauthorized';
    case 'password_change':
      return 'password change required';
    case 'protocol':
      return 'protocol';
    case 'network':
      return 'network';
    default:
      return 'not connected';
  }
}

/** Overall health shown by the pill (pure; exported for tests). */
export function healthState(
  socket: 'idle' | 'connecting' | 'connected' | 'offline',
  restOk: boolean,
): { readonly label: string; readonly tone: 'success' | 'warn' | 'danger' | 'neutral' } {
  if (socket === 'offline') return { label: 'Offline', tone: 'danger' };
  if (socket === 'connecting') return { label: 'Connecting', tone: 'warn' };
  if (!restOk) return { label: 'Degraded', tone: 'warn' };
  if (socket === 'connected') return { label: 'Live', tone: 'success' };
  return { label: 'Idle', tone: 'neutral' };
}

const DOT = {
  success: 'bg-success-solid',
  warn: 'bg-warn-solid',
  danger: 'bg-danger-solid',
  neutral: 'bg-neutral-solid',
} as const;

/** Health pill. `compact` shows only the dot (the label is in the accessible name and the popover). */
export function HealthPill({ compact = false }: { readonly compact?: boolean }) {
  const socket = useSocketState();
  const queryClient = useQueryClient();
  const clock = useServerClock();
  const [restOk, setRestOk] = useState(true);
  useEffect(() => {
    const check = () => {
      const latest = Math.max(
        0,
        ...queryClient
          .getQueryCache()
          .getAll()
          .map((q) => q.state.dataUpdatedAt),
      );
      setRestOk(latest === 0 || clock.now() - latest <= REST_FRESH_MS + 1000);
    };
    check();
    // Cache events fire while a component renders a new query; defer so no other component updates mid-render.
    const unsubscribe = queryClient.getQueryCache().subscribe(() => queueMicrotask(check));
    const timer = setInterval(check, 5000);
    return () => {
      unsubscribe();
      clearInterval(timer);
    };
  }, [queryClient, clock]);
  const { label, tone } = healthState(socket.status, restOk);
  const realtime =
    socket.status === 'offline'
      ? `Offline (${offlineReasonLabel(socket.reason)})`
      : capitalise(socket.status);
  const rows: readonly (readonly [string, string])[] = [
    ['Realtime', realtime],
    ['REST', restOk ? 'Healthy' : 'No recent answer'],
    ...(socket.serverVersion !== null ? [['Daemon', `v${socket.serverVersion}`] as const] : []),
  ];
  return (
    <Popover>
      <PopoverTrigger
        render={
          <Button
            type="button"
            variant="ghost"
            size={compact ? 'icon-sm' : 'sm'}
            aria-label={`Connection: ${label}`}
            className={cn(
              'mr-1 rounded-full text-muted-foreground',
              !compact && 'border border-border px-3 hover:text-foreground',
            )}
          />
        }
      >
        <span aria-hidden="true" className="relative flex size-2">
          {tone === 'success' || tone === 'warn' ? (
            <span
              className={cn(
                'absolute inset-0 animate-ping rounded-full opacity-40 motion-reduce:hidden',
                DOT[tone],
                tone === 'success' && '[animation-duration:2.5s]',
              )}
            />
          ) : null}
          <span className={cn('relative size-2 rounded-full', DOT[tone])} />
        </span>
        {compact ? null : <span>{label}</span>}
      </PopoverTrigger>
      <PopoverContent align="end" sideOffset={8} className="w-64 gap-3">
        <PopoverHeader>
          <PopoverTitle className="flex items-center gap-2">
            <span aria-hidden="true" className={cn('size-2 rounded-full', DOT[tone])} />
            Connection {label.toLowerCase()}
          </PopoverTitle>
        </PopoverHeader>
        <dl className="flex flex-col text-sm">
          {rows.map(([key, value]) => (
            <div key={key} className="flex items-center justify-between gap-4 py-1">
              <dt className="text-muted-foreground">{key}</dt>
              <dd className="text-right font-medium text-foreground">{value}</dd>
            </div>
          ))}
        </dl>
      </PopoverContent>
    </Popover>
  );
}

function capitalise(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}
