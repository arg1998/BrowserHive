/** @module features/overview/components/LinkList — flush list rows that are whole-row real links (stretched `<a data-row-link>`: middle/ctrl-click and "open in new tab" work; inline controls sit above it), hover fill, inset focus ring; used by the Overview panels and Notifications */
import type { ReactNode } from 'react';
import { isPlainClick, useHrefNavigate } from '@/components/shared/DataTableBody.tsx';
import { cn } from '@/lib/utils.ts';

/** Props. */
export interface LinkListProps {
  readonly label: string;
  readonly children: ReactNode;
  readonly className?: string;
}

/** Flush list (row dividers only). */
export function LinkList({ label, children, className }: LinkListProps) {
  return (
    <ul aria-label={label} className={cn('flex flex-col divide-y divide-border', className)}>
      {children}
    </ul>
  );
}

/** Props. */
export interface LinkRowProps {
  /** Target; rows without one render as plain rows. */
  readonly href: string | undefined;
  /** Accessible name of the row link. */
  readonly label: string;
  readonly children: ReactNode;
  /** Runs before navigating (e.g. mark a notification read). Also runs for modifier clicks. */
  readonly onOpen?: () => void;
  readonly className?: string;
}

/** One whole-row link. Put entity titles in `group-hover/row:underline` spans. */
export function LinkRow({ href, label, children, onOpen, className }: LinkRowProps) {
  const go = useHrefNavigate();
  return (
    <li
      data-row-link-scope={href !== undefined ? '' : undefined}
      data-reveal-scope=""
      className={cn(
        'group/row relative min-w-0 transition-colors duration-(--duration-fast)',
        href !== undefined &&
          'hover:bg-accent/70 has-[[data-row-link]:focus-visible]:bg-accent/70 dark:hover:bg-white/[0.035]',
        className,
      )}
    >
      {href !== undefined ? (
        <a
          href={href}
          data-row-link=""
          className="absolute inset-0 rounded-[inherit] focus-ring-inset"
          onClick={(event) => {
            onOpen?.();
            if (!isPlainClick(event)) return;
            event.preventDefault();
            go(href);
          }}
          onAuxClick={() => onOpen?.()}
        >
          <span className="sr-only">{label}</span>
        </a>
      ) : null}
      {children}
    </li>
  );
}
