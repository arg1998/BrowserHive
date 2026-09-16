/** @module components/ui/textarea — shadcn (base-nova) copy; same field chrome as `Input`, auto-sizing */
import type * as React from 'react';
import { cn } from '@/lib/utils.ts';
import { fieldClasses } from './input.tsx';

function Textarea({ className, ...props }: React.ComponentProps<'textarea'>) {
  return (
    <textarea
      data-slot="textarea"
      className={cn(fieldClasses, 'flex field-sizing-content min-h-20 px-3 py-2', className)}
      {...props}
    />
  );
}

export { Textarea };
