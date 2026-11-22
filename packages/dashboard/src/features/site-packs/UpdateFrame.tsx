/** @module features/site-packs/UpdateFrame — the card frame of a decision waiting for review (an update, a revoked version or a local file): the pack's title (bidi-isolated, linking to the pack), what the card is about, its facts, the diff and the footer (a selection box at the start, the actions at the end); the heading takes focus after an action */

import type { SitePackView } from '@browserhive/contracts/http';
import { Link } from '@tanstack/react-router';
import type { ReactNode } from 'react';
import { Plain } from '@/components/shared/Plain.tsx';

/** The frame every decision card shares: heading row, facts, the diff, the footer. */
export function UpdateFrame({
  pack,
  headingId,
  heading,
  badge,
  facts,
  diff,
  start,
  actions,
}: {
  readonly pack: SitePackView;
  readonly headingId: string;
  readonly heading: string;
  readonly badge: ReactNode;
  readonly facts: ReactNode;
  readonly diff: ReactNode;
  /** Left of the footer (a selection box). */
  readonly start?: ReactNode;
  readonly actions: ReactNode;
}) {
  return (
    <article
      aria-labelledby={headingId}
      data-pack={pack.pack_id}
      className="flex min-w-0 flex-col rounded-xl border bg-card shadow-xs dark:shadow-none"
    >
      <div className="flex min-w-0 flex-col gap-3 p-5">
        <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1.5">
          <h3
            id={headingId}
            tabIndex={-1}
            data-card-heading=""
            className="text-base font-semibold focus-ring rounded-sm"
          >
            <Link
              to="/site-packs/$id"
              params={{ id: pack.pack_id }}
              className="hover:underline underline-offset-4 focus-ring rounded-sm"
            >
              <Plain>{pack.title}</Plain>
            </Link>{' '}
            <span className="font-normal text-muted-foreground">{heading}</span>
          </h3>
          {badge}
        </div>
        <div className="flex min-w-0 flex-col gap-1 text-sm text-muted-foreground">{facts}</div>
        {diff}
      </div>
      <div className="mt-auto flex flex-wrap items-center gap-2 border-t bg-muted/40 px-5 py-2.5 dark:bg-white/[0.02]">
        {start !== undefined ? <div className="mr-auto flex items-center">{start}</div> : null}
        <div className="ml-auto flex flex-wrap items-center justify-end gap-2">{actions}</div>
      </div>
    </article>
  );
}
