/** @module components/shared/Toolbar — `role="toolbar"` row that wraps to two rows under `sm` (spec 04 §10) */
import type { ComponentProps } from 'react';
import { cn } from '@/lib/utils.ts';

/** Toolbar. */
export function Toolbar({
  className,
  ...props
}: ComponentProps<'div'> & { readonly 'aria-label': string }) {
  return (
    <div role="toolbar" className={cn('flex flex-wrap items-center gap-2', className)} {...props} />
  );
}
