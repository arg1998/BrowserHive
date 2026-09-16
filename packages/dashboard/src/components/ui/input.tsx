/** @module components/ui/input — shadcn (base-nova) copy on Base UI; 36px (32px with `size="sm"`), 14px text, accent focus ring */

import { Input as InputPrimitive } from '@base-ui/react/input';
import type * as React from 'react';
import { cn } from '@/lib/utils.ts';

/** Shared field chrome for inputs, textareas and select triggers. */
export const fieldClasses =
  'w-full min-w-0 rounded-md border border-input bg-card text-base text-foreground shadow-xs transition-[color,border-color,box-shadow] duration-(--duration-fast) outline-none placeholder:text-subtle-foreground hover:border-border-strong focus:border-ring focus:ring-3 focus:ring-ring/20 focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-destructive/20 dark:bg-white/[0.03]';

function Input({
  className,
  type,
  size = 'default',
  ...props
}: Omit<React.ComponentProps<'input'>, 'size'> & { size?: 'default' | 'sm' | undefined }) {
  return (
    <InputPrimitive
      type={type}
      data-slot="input"
      data-size={size}
      className={cn(
        fieldClasses,
        'h-9 px-3 py-1 pointer-coarse:h-10 data-[size=sm]:h-8 pointer-coarse:data-[size=sm]:h-10 data-[size=sm]:px-2.5 file:inline-flex file:h-7 file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-foreground [&::-webkit-search-cancel-button]:hidden',
        className,
      )}
      {...props}
    />
  );
}

export { Input };
