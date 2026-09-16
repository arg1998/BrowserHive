/** @module features/overview/components/PanelLink — the one panel-header action style: a ghost link button with a trailing arrow ("All sessions →") */
import { Link } from '@tanstack/react-router';
import type { ReactNode } from 'react';
import { buttonVariants } from '@/components/ui/button.tsx';
import { ICONS } from '@/lib/icons.ts';
import { cn } from '@/lib/utils.ts';

/** Props. */
export interface PanelLinkProps {
  readonly to: string;
  readonly search?: Record<string, unknown>;
  readonly children: ReactNode;
  readonly className?: string;
}

/** Panel header link. */
export function PanelLink({ to, search, children, className }: PanelLinkProps) {
  const Arrow = ICONS.arrowRight;
  return (
    <Link
      to={to}
      {...(search !== undefined && { search })}
      className={cn(
        buttonVariants({ variant: 'ghost', size: 'sm' }),
        'group/panel-link -mr-2 text-muted-foreground hover:text-foreground',
        className,
      )}
    >
      {children}
      <Arrow
        aria-hidden="true"
        className="transition-transform duration-(--duration-fast) group-hover/panel-link:translate-x-0.5"
      />
    </Link>
  );
}
