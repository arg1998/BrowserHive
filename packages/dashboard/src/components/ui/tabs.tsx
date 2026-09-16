/** @module components/ui/tabs — shadcn (base-nova) copy on Base UI; `line` = underline tabs with a sliding indicator (no overflow), `segmented` = pill switcher */

import { Tabs as TabsPrimitive } from '@base-ui/react/tabs';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/utils.ts';

function Tabs({ className, orientation = 'horizontal', ...props }: TabsPrimitive.Root.Props) {
  return (
    <TabsPrimitive.Root
      data-slot="tabs"
      data-orientation={orientation}
      className={cn('group/tabs flex gap-4 data-horizontal:flex-col', className)}
      {...props}
    />
  );
}

const tabsListVariants = cva(
  'group/tabs-list relative inline-flex w-fit items-center text-muted-foreground group-data-vertical/tabs:h-fit group-data-vertical/tabs:flex-col group-data-vertical/tabs:items-stretch',
  {
    variants: {
      variant: {
        /**
         * Underline tabs for page sections: full-width hairline, 40px tall, active underline. The
         * scroller bleeds 8px past the content edge on both sides (hairline and text stay aligned)
         * so the tabs' focus ring is not clipped by the horizontal scroller.
         */
        line: '-mx-2 h-10 w-[calc(100%+1rem)] justify-start gap-5 overflow-x-auto overflow-y-hidden bg-[linear-gradient(var(--border),var(--border))] bg-size-[calc(100%-1rem)_1px] bg-position-[0.5rem_100%] bg-no-repeat px-2 [scrollbar-width:none] group-data-vertical/tabs:mx-0 group-data-vertical/tabs:w-fit group-data-vertical/tabs:gap-0.5 group-data-vertical/tabs:overflow-visible group-data-vertical/tabs:bg-none group-data-vertical/tabs:px-0',
        /** Segmented control for view switches (list/table, time range). */
        segmented: 'h-9 gap-0.5 rounded-lg bg-muted p-0.5 pointer-coarse:h-11 dark:bg-white/[0.06]',
      },
    },
    defaultVariants: {
      variant: 'line',
    },
  },
);

function TabsList({
  className,
  variant = 'line',
  children,
  ...props
}: TabsPrimitive.List.Props & VariantProps<typeof tabsListVariants>) {
  return (
    <TabsPrimitive.List
      data-slot="tabs-list"
      data-variant={variant}
      className={cn(tabsListVariants({ variant }), className)}
      {...props}
    >
      {children}
      {variant === 'line' ? (
        <TabsPrimitive.Indicator
          data-slot="tabs-indicator"
          className="absolute bottom-0 left-(--active-tab-left) h-0.5 w-(--active-tab-width) rounded-full bg-foreground transition-[left,width] duration-(--duration-base) ease-(--ease-out) group-data-vertical/tabs:hidden"
        />
      ) : null}
    </TabsPrimitive.List>
  );
}

function TabsTrigger({ className, ...props }: TabsPrimitive.Tab.Props) {
  return (
    <TabsPrimitive.Tab
      data-slot="tabs-trigger"
      className={cn(
        "relative inline-flex cursor-pointer items-center justify-center gap-2 text-base font-medium whitespace-nowrap text-muted-foreground transition-colors duration-(--duration-fast) focus-ring hover:text-foreground disabled:pointer-events-none disabled:opacity-50 aria-disabled:pointer-events-none aria-disabled:opacity-50 data-active:text-foreground [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
        'group-data-[variant=line]/tabs-list:my-1 group-data-[variant=line]/tabs-list:h-8 group-data-[variant=line]/tabs-list:rounded-xs group-data-[variant=line]/tabs-list:px-0.5 pointer-coarse:group-data-[variant=line]/tabs-list:my-0 pointer-coarse:group-data-[variant=line]/tabs-list:h-10 group-data-vertical/tabs:group-data-[variant=line]/tabs-list:my-0 group-data-vertical/tabs:group-data-[variant=line]/tabs-list:h-9 group-data-vertical/tabs:group-data-[variant=line]/tabs-list:justify-start group-data-vertical/tabs:group-data-[variant=line]/tabs-list:rounded-md group-data-vertical/tabs:group-data-[variant=line]/tabs-list:px-3 group-data-vertical/tabs:group-data-[variant=line]/tabs-list:data-active:bg-accent',
        'group-data-[variant=segmented]/tabs-list:h-8 pointer-coarse:group-data-[variant=segmented]/tabs-list:h-10 group-data-[variant=segmented]/tabs-list:rounded-md group-data-[variant=segmented]/tabs-list:px-3 group-data-[variant=segmented]/tabs-list:text-sm group-data-[variant=segmented]/tabs-list:data-active:bg-card group-data-[variant=segmented]/tabs-list:data-active:shadow-sm dark:group-data-[variant=segmented]/tabs-list:data-active:bg-white/10',
        className,
      )}
      {...props}
    />
  );
}

function TabsContent({ className, ...props }: TabsPrimitive.Panel.Props) {
  return (
    <TabsPrimitive.Panel
      data-slot="tabs-content"
      className={cn('min-w-0 flex-1 outline-none', className)}
      {...props}
    />
  );
}

export { Tabs, TabsContent, TabsList, TabsTrigger, tabsListVariants };
