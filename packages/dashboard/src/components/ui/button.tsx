/** @module components/ui/button — shadcn (base-nova) copy on Base UI, resized to the dashboard control scale: xs 28 · sm 32 · default 36 · lg 40, square icon sizes at the same heights */
import { Button as ButtonPrimitive } from '@base-ui/react/button';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/utils.ts';

const buttonVariants = cva(
  "group/button relative inline-flex shrink-0 cursor-pointer items-center justify-center gap-2 rounded-md border border-transparent bg-clip-padding text-base font-medium whitespace-nowrap transition-[color,background-color,border-color,box-shadow,opacity] duration-(--duration-fast) focus-ring select-none disabled:pointer-events-none disabled:opacity-50 aria-disabled:pointer-events-none aria-disabled:opacity-50 aria-invalid:border-destructive [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        default:
          'bg-primary text-primary-foreground shadow-xs hover:bg-primary-hover aria-pressed:bg-primary-hover',
        outline:
          'border-input bg-card text-foreground shadow-xs hover:border-border-strong hover:bg-accent aria-expanded:bg-accent aria-pressed:border-accent-border aria-pressed:bg-accent-bg aria-pressed:text-accent-text dark:bg-transparent dark:hover:bg-accent',
        secondary:
          'bg-secondary text-secondary-foreground hover:bg-[color-mix(in_oklch,var(--secondary),var(--foreground)_6%)] aria-expanded:bg-accent aria-pressed:bg-accent-bg aria-pressed:text-accent-text',
        ghost:
          'text-foreground hover:bg-accent aria-expanded:bg-accent aria-pressed:bg-accent [&_svg]:text-muted-foreground hover:[&_svg]:text-foreground aria-expanded:[&_svg]:text-foreground aria-pressed:[&_svg]:text-foreground',
        /** Soft red: destructive actions that sit beside other actions. */
        destructive:
          'bg-danger-bg text-danger-text hover:bg-danger-bg-hover aria-expanded:bg-danger-bg-hover',
        /** Solid red: the confirm button of a destructive dialog. */
        'destructive-solid':
          'bg-destructive text-destructive-foreground shadow-xs hover:bg-[color-mix(in_oklch,var(--destructive),black_12%)]',
        'destructive-ghost': 'text-danger-text hover:bg-danger-bg aria-expanded:bg-danger-bg',
        link: 'h-auto! px-0! text-link underline-offset-4 hover:underline',
      },
      size: {
        default:
          'h-9 px-3.5 pointer-coarse:h-10 has-data-[icon=inline-end]:pr-3 has-data-[icon=inline-start]:pl-3',
        xs: "h-7 pointer-coarse:h-10 gap-1.5 px-2.5 text-sm [&_svg:not([class*='size-'])]:size-3.5",
        sm: 'h-8 pointer-coarse:h-10 gap-1.5 px-3 text-sm has-data-[icon=inline-end]:pr-2.5 has-data-[icon=inline-start]:pl-2.5',
        lg: 'h-10 px-4 pointer-coarse:h-11 has-data-[icon=inline-end]:pr-3.5 has-data-[icon=inline-start]:pl-3.5',
        icon: 'size-9 pointer-coarse:size-10',
        'icon-xs': "size-7 pointer-coarse:size-10 [&_svg:not([class*='size-'])]:size-4",
        'icon-sm': 'size-8 pointer-coarse:size-10',
        'icon-lg': "size-10 [&_svg:not([class*='size-'])]:size-5",
      },
    },
    defaultVariants: {
      variant: 'default',
      size: 'default',
    },
  },
);

/** Button. Pass `aria-pressed` for toggle buttons: every variant has a visible pressed state. */
function Button({
  className,
  variant = 'default',
  size = 'default',
  ...props
}: ButtonPrimitive.Props & VariantProps<typeof buttonVariants>) {
  return (
    <ButtonPrimitive
      data-slot="button"
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  );
}

export { Button, buttonVariants };
