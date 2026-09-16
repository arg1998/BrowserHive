/** @module components/shared/layout — `Stack`/`Grid`/`Inline` gap helpers; components own no outer margins (spec 04 §9) */
import type { ComponentProps } from 'react';
import { cn } from '@/lib/utils.ts';

const GAPS = {
  0: 'gap-0',
  1: 'gap-1',
  2: 'gap-2',
  3: 'gap-3',
  4: 'gap-4',
  6: 'gap-6',
  8: 'gap-8',
} as const;
/** Allowed gap steps. */
export type Gap = keyof typeof GAPS;

/** Vertical stack. */
export function Stack({
  gap = 4,
  className,
  ...props
}: ComponentProps<'div'> & { readonly gap?: Gap }) {
  return <div className={cn('flex flex-col', GAPS[gap], className)} {...props} />;
}

/** Horizontal, wrapping row. */
export function Inline({
  gap = 2,
  className,
  ...props
}: ComponentProps<'div'> & { readonly gap?: Gap }) {
  return <div className={cn('flex flex-wrap items-center', GAPS[gap], className)} {...props} />;
}

/** Auto-fit grid (`minmax(min, 1fr)`) — tiles never orphan. */
export function Grid({
  gap = 4,
  min = 'min',
  className,
  ...props
}: ComponentProps<'div'> & { readonly gap?: Gap; readonly min?: 'min' | 'wide' }) {
  return (
    <div
      className={cn(
        'grid',
        GAPS[gap],
        min === 'min'
          ? 'grid-cols-[repeat(auto-fit,minmax(min(100%,12.5rem),1fr))]'
          : 'grid-cols-[repeat(auto-fit,minmax(min(100%,20rem),1fr))]',
        className,
      )}
      {...props}
    />
  );
}
