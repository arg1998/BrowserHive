/** @module components/shared/EmptyState — one compact empty state per region (no dashed box): zero-data, zero-results (offers Clear filters), not-enabled (docs link) */
import type { ReactNode } from 'react';
import { Button, buttonVariants } from '@/components/ui/button.tsx';
import { ICONS, type IconName } from '@/lib/icons.ts';
import { cn } from '@/lib/utils.ts';

/** Props. */
export interface EmptyStateProps {
  readonly kind: 'zero-data' | 'zero-results' | 'not-enabled';
  readonly icon?: IconName;
  readonly title: string;
  readonly description?: ReactNode;
  readonly action?: ReactNode;
  /** `zero-results`: the clear-filters handler. */
  readonly onClear?: () => void;
  /** `not-enabled`: docs link. */
  readonly docsHref?: string;
  /** `inline` (default): no surface, for use inside a panel or table. `panel`: its own card. */
  readonly variant?: 'inline' | 'panel';
  /** `sm` for small regions (popovers, side panels). */
  readonly size?: 'default' | 'sm';
  readonly className?: string;
}

/** Empty state. */
export function EmptyState({
  kind,
  icon,
  title,
  description,
  action,
  onClear,
  docsHref,
  variant = 'inline',
  size = 'default',
  className,
}: EmptyStateProps) {
  const Icon =
    ICONS[icon ?? (kind === 'not-enabled' ? 'lock' : kind === 'zero-results' ? 'search' : 'inbox')];
  const hasActions =
    action !== undefined ||
    (kind === 'zero-results' && onClear !== undefined) ||
    (kind === 'not-enabled' && docsHref !== undefined);
  return (
    <div
      className={cn(
        'flex flex-col items-center justify-center gap-3 px-6 text-center',
        size === 'sm' ? 'py-6' : 'py-10',
        variant === 'panel' && 'rounded-xl border bg-card shadow-xs dark:shadow-none',
        className,
      )}
      data-kind={kind}
    >
      <span
        className={cn(
          'flex items-center justify-center rounded-full bg-muted text-muted-foreground dark:bg-white/[0.06]',
          size === 'sm' ? 'size-9' : 'size-11',
        )}
      >
        <Icon aria-hidden="true" className="size-5" />
      </span>
      <div className="flex max-w-md flex-col gap-1">
        <p className="text-base font-semibold text-foreground">{title}</p>
        {description !== undefined ? (
          <div className="text-sm text-pretty text-muted-foreground">{description}</div>
        ) : null}
      </div>
      {hasActions ? (
        <div className="mt-1 flex flex-wrap items-center justify-center gap-2">
          {kind === 'zero-results' && onClear !== undefined ? (
            <Button type="button" variant="outline" size="sm" onClick={onClear}>
              Clear filters
            </Button>
          ) : null}
          {kind === 'not-enabled' && docsHref !== undefined ? (
            <a
              href={docsHref}
              target="_blank"
              rel="noreferrer"
              className={buttonVariants({ variant: 'outline', size: 'sm' })}
            >
              Read the docs
            </a>
          ) : null}
          {action}
        </div>
      ) : null}
    </div>
  );
}
