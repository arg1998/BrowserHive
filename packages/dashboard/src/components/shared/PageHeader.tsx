/** @module components/shared/PageHeader — page title (20px semibold), one-line description with an optional "Learn more" popover, right-aligned actions, meta line and tabs underneath */
import type { ReactNode } from 'react';
import { cn } from '@/lib/utils.ts';
import { type InfoDocs, InfoDot } from './InfoDot.tsx';

/** Breadcrumb segment (the topbar renders the trail). */
export interface Crumb {
  readonly label: string;
  readonly to?: string;
}

/** Props. */
export interface PageHeaderProps {
  /** Page title. Object pages pass the object's name (the topbar shows the breadcrumb trail). */
  readonly title?: ReactNode;
  /** Optional crumbs: without a `title`, the last crumb's label becomes the title. The topbar renders the trail. */
  readonly breadcrumb?: readonly Crumb[];
  /** Element before the title (status badge, icon). */
  readonly leading?: ReactNode;
  /** Element right after the title on the same line (state badge, count). */
  readonly badge?: ReactNode;
  /** One muted line under the title; longer explanations go in `learnMore`. */
  readonly description?: ReactNode;
  /** Explainer shown in a popover behind an info button at the end of the description. */
  readonly learnMore?: ReactNode;
  /** "Read the docs" link at the bottom of the `learnMore` popover. */
  readonly learnMoreDocs?: InfoDocs;
  /** Primary + secondary actions, right-aligned (wrap under the title on narrow screens). */
  readonly actions?: ReactNode;
  /**
   * Keep `actions` on the title row at every width (compact icon buttons): the title truncates
   * instead of the actions wrapping under it.
   */
  readonly actionsInline?: boolean;
  /** Secondary facts line (owner · channel · started). */
  readonly meta?: ReactNode;
  /** `Tabs` list rendered under the header, sharing its bottom edge. */
  readonly tabs?: ReactNode;
  readonly className?: string;
}

/** Page header. */
export function PageHeader({
  title,
  breadcrumb,
  leading,
  badge,
  description,
  learnMore,
  learnMoreDocs,
  actions,
  actionsInline = false,
  meta,
  tabs,
  className,
}: PageHeaderProps) {
  const heading = title ?? breadcrumb?.at(-1)?.label;
  const titleText = typeof heading === 'string' ? heading : 'this page';
  return (
    <header className={cn('flex flex-col gap-4', className)}>
      <div
        className={cn(
          'flex items-start justify-between gap-y-3',
          actionsInline ? 'flex-nowrap gap-x-3 sm:gap-x-6' : 'flex-wrap gap-x-6',
        )}
      >
        <div
          className={cn(
            'flex min-w-0 flex-col gap-1',
            actionsInline ? 'flex-1' : 'flex-[1_1_16rem]',
          )}
        >
          <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
            {leading}
            <h1 className="min-w-0 text-xl font-semibold [overflow-wrap:anywhere] text-foreground">
              {heading}
            </h1>
            {badge}
          </div>
          {description !== undefined || learnMore !== undefined ? (
            <div className="flex min-w-0 items-center gap-1 text-sm text-muted-foreground">
              {description !== undefined ? (
                <p className="min-w-0 sm:truncate">{description}</p>
              ) : null}
              {learnMore !== undefined ? (
                <InfoDot
                  label={`Learn more about ${titleText}`}
                  align="start"
                  {...(learnMoreDocs !== undefined && { docs: learnMoreDocs })}
                >
                  {learnMore}
                </InfoDot>
              ) : null}
            </div>
          ) : null}
          {meta !== undefined ? (
            <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-sm text-muted-foreground">
              {meta}
            </div>
          ) : null}
        </div>
        {actions !== undefined ? (
          <div className="flex max-w-full min-w-0 shrink-0 flex-wrap items-center gap-2">
            {actions}
          </div>
        ) : null}
      </div>
      {tabs}
    </header>
  );
}
