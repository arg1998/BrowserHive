/** @module components/ui/tooltip — shadcn (base-nova) copy on Base UI; 500ms open delay (instant between tooltips), 12px inverse surface, no arrow */
import { Tooltip as TooltipPrimitive } from '@base-ui/react/tooltip';
import type * as React from 'react';
import { cn } from '@/lib/utils.ts';

/** Open delay. Moving between tooltips within the provider timeout is instant. */
export const TOOLTIP_DELAY_MS = 500;

function TooltipProvider({
  delay = TOOLTIP_DELAY_MS,
  closeDelay = 0,
  timeout = 400,
  ...props
}: TooltipPrimitive.Provider.Props) {
  return (
    <TooltipPrimitive.Provider
      data-slot="tooltip-provider"
      delay={delay}
      closeDelay={closeDelay}
      timeout={timeout}
      {...props}
    />
  );
}

function Tooltip({ ...props }: TooltipPrimitive.Root.Props) {
  return <TooltipPrimitive.Root data-slot="tooltip" {...props} />;
}

function TooltipTrigger({ ...props }: TooltipPrimitive.Trigger.Props) {
  return <TooltipPrimitive.Trigger data-slot="tooltip-trigger" {...props} />;
}

function TooltipContent({
  className,
  side = 'top',
  sideOffset = 6,
  align = 'center',
  alignOffset = 0,
  children,
  ...props
}: TooltipPrimitive.Popup.Props &
  Pick<TooltipPrimitive.Positioner.Props, 'align' | 'alignOffset' | 'side' | 'sideOffset'>) {
  return (
    <TooltipPrimitive.Portal>
      <TooltipPrimitive.Positioner
        align={align}
        alignOffset={alignOffset}
        side={side}
        sideOffset={sideOffset}
        className="isolate z-(--z-tooltip)"
      >
        <TooltipPrimitive.Popup
          data-slot="tooltip-content"
          className={cn(
            'z-(--z-tooltip) inline-flex w-fit max-w-xs origin-(--transform-origin) flex-col items-start gap-0.5 rounded-md bg-tooltip px-2.5 py-1.5 text-xs leading-4 font-medium text-tooltip-foreground shadow-md has-data-[slot=kbd]:flex-row has-data-[slot=kbd]:items-center has-data-[slot=kbd]:gap-2 **:data-[slot=kbd]:bg-white/15 **:data-[slot=kbd]:text-tooltip-foreground data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95 data-instant:animate-none dark:ring-1 dark:ring-white/10',
            className,
          )}
          {...props}
        >
          {children}
        </TooltipPrimitive.Popup>
      </TooltipPrimitive.Positioner>
    </TooltipPrimitive.Portal>
  );
}

/** Props of `Hint`. */
interface HintProps {
  /** Tooltip body. Omit (or pass `null`) to render the trigger without a tooltip. */
  readonly label: React.ReactNode;
  /** The trigger: one element that accepts a ref and DOM props (Button, Link, span with tabIndex). */
  readonly children: React.ReactElement;
  /** Keyboard shortcut shown beside the label (already formatted, e.g. `Ctrl K`). */
  readonly shortcut?: string | undefined;
  readonly side?: TooltipPrimitive.Positioner.Props['side'];
  readonly align?: TooltipPrimitive.Positioner.Props['align'];
  readonly className?: string;
  /** Keep the trigger but never open (e.g. the full text of a value that isn't truncated). */
  readonly disabled?: boolean;
}

/**
 * One-line tooltip pattern: `<Hint label="Copy id"><Button …/></Hint>`. The child becomes the
 * trigger (it must be focusable). For a disabled button that needs a reason, wrap the button in
 * `<span tabIndex={0}>` so the tooltip still opens on hover and focus.
 */
function Hint({
  label,
  children,
  shortcut,
  side = 'top',
  align = 'center',
  className,
  disabled,
}: HintProps) {
  if (label === null || label === undefined || label === '') return children;
  return (
    <TooltipPrimitive.Root {...(disabled !== undefined && { disabled })}>
      <TooltipPrimitive.Trigger render={children} />
      <TooltipContent side={side} align={align} className={className}>
        <span>{label}</span>
        {shortcut !== undefined ? (
          <kbd data-slot="kbd" className="rounded-xs px-1 font-sans text-xs leading-4 font-medium">
            {shortcut}
          </kbd>
        ) : null}
      </TooltipContent>
    </TooltipPrimitive.Root>
  );
}

export { Hint, Tooltip, TooltipContent, TooltipProvider, TooltipTrigger };
