/** @module components/ui/switch — shadcn (base-nova) copy on Base UI; 36×20 track (28×16 `sm`) with a larger invisible hit area */
import { Switch as SwitchPrimitive } from '@base-ui/react/switch';
import { cn } from '@/lib/utils.ts';

function Switch({
  className,
  size = 'default',
  ...props
}: SwitchPrimitive.Root.Props & {
  size?: 'sm' | 'default';
}) {
  return (
    <SwitchPrimitive.Root
      data-slot="switch"
      data-size={size}
      className={cn(
        'peer group/switch relative inline-flex shrink-0 cursor-pointer items-center rounded-full border border-transparent transition-colors duration-(--duration-fast) focus-ring after:absolute after:-inset-x-2 after:-inset-y-2.5 pointer-coarse:after:-inset-y-3 data-[size=default]:h-5 data-[size=default]:w-9 data-[size=sm]:h-4 data-[size=sm]:w-7 data-checked:bg-primary data-unchecked:bg-border-strong data-disabled:cursor-not-allowed data-disabled:opacity-50 dark:data-unchecked:bg-white/15',
        className,
      )}
      {...props}
    >
      <SwitchPrimitive.Thumb
        data-slot="switch-thumb"
        className="pointer-events-none block rounded-full bg-white shadow-sm ring-0 transition-transform duration-(--duration-fast) group-data-[size=default]/switch:size-4 group-data-[size=sm]/switch:size-3 data-unchecked:translate-x-px group-data-[size=default]/switch:data-checked:translate-x-4.25 group-data-[size=sm]/switch:data-checked:translate-x-3.25"
      />
    </SwitchPrimitive.Root>
  );
}

export { Switch };
