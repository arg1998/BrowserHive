/** @module features/site-packs/detail/PackSection — the frame of one section of a pack's page (a titled card with an anchor, so the page is navigable by heading) and its definition rows */
import type { ReactNode } from 'react';
import { Panel } from '@/components/shared/Section.tsx';
import type { DocsPage } from '@/lib/links.ts';

/** A section card. */
export function PackSection({
  title,
  description,
  docs,
  children,
}: {
  readonly title: string;
  readonly description?: ReactNode;
  /** The guide section that explains it, behind an info button. */
  readonly docs?: DocsPage;
  readonly children: ReactNode;
}) {
  return (
    <Panel
      title={title}
      {...(description !== undefined && { description })}
      {...(docs !== undefined && {
        info: <p>The site packs guide explains this section.</p>,
        infoDocs: docs,
      })}
    >
      <div className="flex min-w-0 flex-col gap-4">{children}</div>
    </Panel>
  );
}

/** Label/value rows. */
export function Facts({
  rows,
}: {
  readonly rows: readonly (readonly [string, ReactNode] | null | false)[];
}) {
  return (
    <dl className="flex min-w-0 flex-col divide-y">
      {rows.map((row) =>
        row === null || row === false ? null : (
          <div
            key={row[0]}
            className="grid min-w-0 gap-1 py-2.5 first:pt-0 last:pb-0 sm:grid-cols-[12rem_minmax(0,1fr)] sm:gap-4"
          >
            <dt className="text-sm font-medium text-muted-foreground">{row[0]}</dt>
            <dd className="min-w-0 text-base text-pretty [overflow-wrap:anywhere]">{row[1]}</dd>
          </div>
        ),
      )}
    </dl>
  );
}

/** Mono text (selectors, globs, ids). */
export function Code({ children }: { readonly children: ReactNode }) {
  return (
    <code className="rounded bg-muted px-1 py-0.5 font-mono text-[0.8125rem] [overflow-wrap:anywhere] dark:bg-white/[0.06]">
      {children}
    </code>
  );
}

/**
 * A compact table whose cells wrap instead of overflowing. Under 640px each row becomes a small
 * card: the first cell and the last (the action) side by side, the middle cell (what it matches)
 * below them.
 */
export function RuleTable({
  label,
  head,
  children,
}: {
  readonly label: string;
  readonly head: readonly string[];
  readonly children: ReactNode;
}) {
  return (
    <div className="min-w-0 overflow-x-auto rounded-lg border">
      <table
        aria-label={label}
        className="w-full min-w-0 border-collapse text-sm max-sm:block max-sm:[&_tbody]:block max-sm:[&_td:nth-child(2)]:col-span-2 max-sm:[&_td:nth-child(2)]:row-start-2 max-sm:[&_td:nth-child(2)]:pt-0 max-sm:[&_td:nth-child(3)]:text-right max-sm:[&_td]:block max-sm:[&_tr]:grid max-sm:[&_tr]:grid-cols-[minmax(0,1fr)_auto]"
      >
        <thead className="bg-muted/50 text-left text-xs text-muted-foreground max-sm:hidden dark:bg-white/[0.03]">
          <tr>
            {head.map((h) => (
              <th key={h} scope="col" className="px-3 py-2 font-medium">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y align-top [&_td]:px-3 [&_td]:py-2.5 [&_td]:break-words">
          {children}
        </tbody>
      </table>
    </div>
  );
}
