/** @module components/ui/label — shadcn (base-nova) copy; 13px medium field label, clickable */

import type * as React from 'react';
import { cn } from '@/lib/utils.ts';

function Label({ className, ...props }: React.ComponentProps<'label'>) {
  return (
    // biome-ignore lint/a11y/noLabelWithoutControl: callers pass `htmlFor`/children (vendored)
    <label
      data-slot="label"
      className={cn(
        'flex items-center gap-2 text-sm leading-5 font-medium text-foreground select-none group-data-[disabled=true]:pointer-events-none group-data-[disabled=true]:opacity-50 peer-disabled:cursor-not-allowed peer-disabled:opacity-50',
        className,
      )}
      {...props}
    />
  );
}

export { Label };
