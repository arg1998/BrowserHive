/** @module components/ui/skeleton — shadcn (base-nova) copy; soft pulse on the muted fill */
import { cn } from '@/lib/utils.ts';

function Skeleton({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="skeleton"
      className={cn('animate-pulse rounded-md bg-muted dark:bg-white/[0.06]', className)}
      {...props}
    />
  );
}

export { Skeleton };
