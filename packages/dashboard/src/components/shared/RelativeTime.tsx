/** @module components/shared/RelativeTime — server-anchored relative text (fixed-width tabular digits) with the absolute time in a tooltip; ticks 1 Hz while visible */
import { Hint } from '@/components/ui/tooltip.tsx';
import { formatAbsolute, formatAbsoluteShort, formatRelative } from '@/lib/format/time.ts';
import { useServerNow } from '@/lib/server-now.ts';
import { cn } from '@/lib/utils.ts';

/** Props. */
export interface RelativeTimeProps {
  readonly at: number;
  /** Server-anchored now; defaults to `useServerNow()`. */
  readonly now?: number;
  /** `relative` (default) `5m ago`; `absolute` `Sep 16, 14:05`; `both` `Sep 16, 14:05 · 5m ago`. */
  readonly mode?: 'relative' | 'absolute' | 'both';
  readonly className?: string;
}

/** Relative + absolute time. The tooltip always carries the full absolute timestamp. */
export function RelativeTime({ at, now, mode = 'relative', className }: RelativeTimeProps) {
  const liveNow = useServerNow();
  const anchor = now ?? liveNow;
  const relative = formatRelative(at, anchor);
  const absolute = formatAbsolute(at);
  const iso = new Date(at).toISOString();
  const text =
    mode === 'absolute' ? (
      formatAbsoluteShort(at)
    ) : mode === 'both' ? (
      <>
        {formatAbsoluteShort(at)} <span className="text-muted-foreground">· {relative}</span>
      </>
    ) : (
      relative
    );
  return (
    <Hint label={mode === 'absolute' ? `${absolute} · ${relative}` : absolute}>
      <time
        dateTime={iso}
        data-absolute={absolute}
        className={cn(
          'inline-block whitespace-nowrap tabular-nums',
          mode === 'relative' && 'min-w-[7ch]',
          className,
        )}
      >
        {text}
      </time>
    </Hint>
  );
}
