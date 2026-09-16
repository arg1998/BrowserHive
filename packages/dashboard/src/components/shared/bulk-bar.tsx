/** @module components/shared/bulk-bar — selection actions bar and `SelectionToolbar`, which overlays it on the filter toolbar's slot so nothing below shifts */
import { Progress as ProgressPrimitive } from '@base-ui/react/progress';
import type { ReactNode } from 'react';
import { Button } from '@/components/ui/button.tsx';
import { ProgressIndicator, ProgressTrack } from '@/components/ui/progress.tsx';
import { Hint } from '@/components/ui/tooltip.tsx';
import { formatNumber } from '@/lib/format/bytes.ts';
import { ICONS, type IconName } from '@/lib/icons.ts';
import { cn } from '@/lib/utils.ts';
import { Toolbar } from './Toolbar.tsx';

/** One bulk action. */
export interface BulkAction {
  readonly id: string;
  readonly label: string;
  readonly onClick: () => void;
  /** Destructive styling (delete, terminate). */
  readonly danger?: boolean;
  readonly disabled?: boolean;
  /** Why the action is disabled, or what it will skip ("Live sessions are skipped"): shown as a tooltip. */
  readonly hint?: string;
  readonly icon?: IconName;
}

/** Props. */
export interface BulkBarProps {
  /** Selected row count. */
  readonly count: number;
  /** Rows matching the current filters; enables "Select all {total} matching" when larger. */
  readonly total?: number;
  /** Noun for the selection (default `sessions`). */
  readonly noun?: string;
  readonly actions: readonly BulkAction[];
  readonly onSelectAll?: () => void;
  readonly onClear: () => void;
  /** Disables every control; shows the progress meter when `progress` is given. */
  readonly busy?: boolean;
  /** Determinate progress 0–1 while a bulk operation runs. */
  readonly progress?: number;
  readonly className?: string;
}

/** Bulk bar: 44px accent-tinted bar (count · select all · actions · one Clear control). */
export function BulkBar({
  count,
  total,
  noun = 'sessions',
  actions,
  onSelectAll,
  onClear,
  busy = false,
  progress,
  className,
}: BulkBarProps) {
  const Close = ICONS.close;
  const canSelectAll = onSelectAll !== undefined && total !== undefined && total > count;
  const pct = progress === undefined ? 0 : Math.round(Math.max(0, Math.min(1, progress)) * 100);
  return (
    <div
      className={cn(
        'relative flex min-h-11 flex-col justify-center overflow-hidden rounded-lg border border-accent-border bg-accent-bg px-2 py-1.5 shadow-sm',
        className,
      )}
      aria-busy={busy}
    >
      <Toolbar aria-label="Bulk actions" className="gap-1.5">
        <span className="pr-1 pl-1.5 text-base font-semibold tabular-nums" aria-live="polite">
          {formatNumber(count)} selected
        </span>
        {canSelectAll ? (
          <Button type="button" variant="link" size="sm" disabled={busy} onClick={onSelectAll}>
            Select all {formatNumber(total)} matching
          </Button>
        ) : null}
        <div className="ml-auto flex flex-wrap items-center gap-1.5">
          {actions.map((action) => {
            const Icon = action.icon !== undefined ? ICONS[action.icon] : null;
            const disabled = busy || action.disabled === true;
            const button = (
              <Button
                key={action.id}
                type="button"
                size="sm"
                variant={action.danger === true ? 'destructive' : 'outline'}
                disabled={disabled}
                onClick={action.onClick}
              >
                {Icon !== null ? <Icon aria-hidden="true" /> : null}
                {action.label}
              </Button>
            );
            // A disabled action says why (the wrapper keeps the tooltip reachable).
            return action.hint !== undefined ? (
              <Hint key={action.id} label={action.hint}>
                <span tabIndex={disabled ? 0 : -1} className="inline-flex rounded-md">
                  {button}
                </span>
              </Hint>
            ) : (
              button
            );
          })}
          <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={onClear}>
            <Close aria-hidden="true" />
            Clear
          </Button>
        </div>
      </Toolbar>
      {busy && progress !== undefined ? (
        <ProgressPrimitive.Root
          value={pct}
          aria-label={`Processing ${noun}`}
          className="absolute inset-x-0 bottom-0"
        >
          <ProgressTrack className="h-0.5 rounded-none bg-transparent">
            <ProgressIndicator />
          </ProgressTrack>
        </ProgressPrimitive.Root>
      ) : null}
    </div>
  );
}

/** Props. */
export interface SelectionToolbarProps {
  /** The filter toolbar; it keeps its space (and becomes inert) while the bulk bar is shown. */
  readonly children: ReactNode;
  /** The bulk bar, or `null` when nothing is selected. */
  readonly bulk: ReactNode;
  readonly className?: string;
}

/**
 * One toolbar slot for filters and bulk actions. The bulk bar overlays the filters at the same
 * position instead of replacing them, so the table below never jumps when a row is selected.
 */
export function SelectionToolbar({ children, bulk, className }: SelectionToolbarProps) {
  const active = bulk !== null && bulk !== undefined && bulk !== false;
  return (
    <div className={cn('relative min-h-11', className)}>
      <div
        inert={active}
        aria-hidden={active ? true : undefined}
        className={cn(
          'transition-opacity duration-(--duration-fast)',
          active && 'pointer-events-none opacity-0',
        )}
      >
        {children}
      </div>
      {active ? (
        <div className="absolute inset-x-0 top-0 z-(--z-sticky) animate-in duration-150 fade-in-0 slide-in-from-top-1">
          {bulk}
        </div>
      ) : null}
    </div>
  );
}
