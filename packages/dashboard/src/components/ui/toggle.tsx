/** @module components/ui/toggle — shadcn (base-nova) copy on Base UI; 36/32px (40px on touch), clear pressed state */

import { Toggle as TogglePrimitive } from '@base-ui/react/toggle';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/utils.ts';

const toggleVariants = cva(
  "group/toggle inline-flex cursor-pointer items-center justify-center gap-1.5 rounded-md text-base font-medium whitespace-nowrap text-muted-foreground transition-colors duration-(--duration-fast) focus-ring hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-50 aria-pressed:bg-accent aria-pressed:text-foreground data-pressed:bg-accent data-pressed:text-foreground [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        default: 'bg-transparent',
        outline:
          'border border-input bg-card shadow-xs hover:bg-accent data-pressed:border-accent-border data-pressed:bg-accent-bg data-pressed:text-accent-text dark:bg-transparent',
      },
      size: {
        default: 'h-9 min-w-9 px-3 pointer-coarse:h-10 pointer-coarse:min-w-10',
        sm: 'h-8 min-w-8 px-2.5 text-sm pointer-coarse:h-10 pointer-coarse:min-w-10',
        lg: 'h-10 min-w-10 px-3.5',
      },
    },
    defaultVariants: {
      variant: 'default',
      size: 'default',
    },
  },
);

function Toggle({
  className,
  variant = 'default',
  size = 'default',
  ...props
}: TogglePrimitive.Props & VariantProps<typeof toggleVariants>) {
  return (
    <TogglePrimitive
      data-slot="toggle"
      className={cn(toggleVariants({ variant, size, className }))}
      {...props}
    />
  );
}

export { Toggle, toggleVariants };
