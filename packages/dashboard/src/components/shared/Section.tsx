/** @module components/shared/Section — labelled page section (`<h2>` + count + actions) and `Panel`, the one card surface (12px radius, hairline, xs shadow in light) */
import { type ReactNode, useId } from 'react';
import { formatNumber } from '@/lib/format/bytes.ts';
import { cn } from '@/lib/utils.ts';
import { type InfoDocs, InfoDot } from './InfoDot.tsx';

/** Props. */
export interface SectionProps {
  readonly title: ReactNode;
  readonly description?: ReactNode;
  /** Explainer behind an info button after the title. */
  readonly info?: ReactNode;
  /** "Read the docs" link under `info`. */
  readonly infoDocs?: InfoDocs;
  readonly count?: number;
  readonly actions?: ReactNode;
  readonly children: ReactNode;
  readonly className?: string;
}

/** Info button beside a heading; named after the heading when it is plain text. */
function TitleInfo({
  title,
  info,
  docs,
}: {
  readonly title: ReactNode;
  readonly info: ReactNode;
  readonly docs: InfoDocs | undefined;
}) {
  return (
    <span className="inline-flex font-normal">
      <InfoDot
        label={typeof title === 'string' ? `About ${title}` : 'About this section'}
        align="start"
        {...(docs !== undefined && { docs })}
      >
        {info}
      </InfoDot>
    </span>
  );
}

/** Labelled section: heading row, then content. No surface of its own. */
export function Section({
  title,
  description,
  info,
  infoDocs,
  count,
  actions,
  children,
  className,
}: SectionProps) {
  const id = useId();
  return (
    <section aria-labelledby={id} className={cn('flex min-w-0 flex-col gap-3', className)}>
      <div className="flex min-h-8 flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <div className="flex min-w-0 flex-col">
          <h2 id={id} className="flex items-center gap-2 text-md font-semibold">
            {title}
            {count !== undefined ? (
              <span className="rounded-full bg-muted px-2 text-xs leading-5 font-medium text-muted-foreground tabular-nums dark:bg-white/[0.07]">
                {formatNumber(count)}
              </span>
            ) : null}
            {info !== undefined ? <TitleInfo title={title} info={info} docs={infoDocs} /> : null}
          </h2>
          {description !== undefined ? (
            <p className="text-sm text-muted-foreground">{description}</p>
          ) : null}
        </div>
        {actions !== undefined ? <div className="flex items-center gap-2">{actions}</div> : null}
      </div>
      {children}
    </section>
  );
}

/** Props. */
export interface PanelProps {
  readonly title?: ReactNode;
  readonly description?: ReactNode;
  /** Explainer behind an info button after the title. */
  readonly info?: ReactNode;
  /** "Read the docs" link under `info`. */
  readonly infoDocs?: InfoDocs;
  readonly actions?: ReactNode;
  readonly children: ReactNode;
  /** `default` 20px padding; `none` for flush content (tables, lists with their own row padding). */
  readonly padding?: 'default' | 'none';
  readonly className?: string;
  readonly bodyClassName?: string;
}

/** Card surface with an optional header row. One hairline, never nested inside another panel. */
export function Panel({
  title,
  description,
  info,
  infoDocs,
  actions,
  children,
  padding = 'default',
  className,
  bodyClassName,
}: PanelProps) {
  const id = useId();
  const hasHeader = title !== undefined || actions !== undefined;
  return (
    <section
      aria-labelledby={title !== undefined ? id : undefined}
      className={cn(
        'flex min-w-0 flex-col rounded-xl border bg-card text-card-foreground shadow-xs dark:shadow-none',
        className,
      )}
    >
      {hasHeader ? (
        <div
          className={cn(
            'flex min-h-14 flex-wrap items-center justify-between gap-x-4 gap-y-2 px-5 pt-4',
            padding === 'none' ? 'pb-3' : 'pb-0',
          )}
        >
          <div className="flex min-w-0 flex-col">
            {title !== undefined ? (
              <h2 id={id} className="flex items-center gap-1 text-base font-semibold">
                {title}
                {info !== undefined ? (
                  <TitleInfo title={title} info={info} docs={infoDocs} />
                ) : null}
              </h2>
            ) : null}
            {description !== undefined ? (
              <p className="text-sm text-muted-foreground">{description}</p>
            ) : null}
          </div>
          {actions !== undefined ? <div className="flex items-center gap-2">{actions}</div> : null}
        </div>
      ) : null}
      <div className={cn('min-w-0 flex-1', padding === 'default' && 'p-5', bodyClassName)}>
        {children}
      </div>
    </section>
  );
}
