/** @module components/shared/InfoDot — "Learn more" explainer: a small info icon button that opens a popover */
import type { ReactNode } from 'react';
import { Button } from '@/components/ui/button.tsx';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover.tsx';
import { ICONS } from '@/lib/icons.ts';

/** Props. */
export interface InfoDotProps {
  /** Accessible name of the trigger (`About open attention`). */
  readonly label: string;
  readonly children: ReactNode;
}

/** Info popover. */
export function InfoDot({ label, children }: InfoDotProps) {
  const Icon = ICONS.info;
  return (
    <Popover>
      <PopoverTrigger
        render={
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            aria-label={label}
            // A 40px touch target without growing the line it sits in.
            className="size-6 rounded-full after:absolute after:-inset-2 after:rounded-full pointer-coarse:size-6"
            onClick={(event) => event.stopPropagation()}
          />
        }
      >
        <Icon aria-hidden="true" />
      </PopoverTrigger>
      <PopoverContent className="w-80 text-sm leading-5 text-popover-foreground">
        {children}
      </PopoverContent>
    </Popover>
  );
}
