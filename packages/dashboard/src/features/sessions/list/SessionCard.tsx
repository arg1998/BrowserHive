/** @module features/sessions/list/SessionCard — `/sessions` card under 768px (the whole card is the row link): slug + state, id, last URL, activity and lease */
import type { SessionSummary } from '@browserhive/contracts/http';
import type { ReactNode } from 'react';
import { splitUrl } from '@/components/shared/url-cell.tsx';
import { Checkbox } from '@/components/ui/checkbox.tsx';
import { HarnessName } from '../../harness/HarnessName.tsx';
import { browserLabel } from '../session-format.ts';
import { ActivityCell, idSuffix, StateCell } from './sessions-columns.tsx';

/** Props. */
export interface SessionCardProps {
  readonly session: SessionSummary;
  readonly now: number;
  readonly selected: boolean;
  readonly onSelect: (selected: boolean) => void;
  readonly actions: ReactNode;
}

/** Card. */
export function SessionCard({ session, now, selected, onSelect, actions }: SessionCardProps) {
  const browser = browserLabel(session);
  const url =
    session.current_url !== null && session.current_url !== ''
      ? splitUrl(session.current_url)
      : null;
  return (
    <article className="flex flex-col gap-3" aria-label={session.slug} data-band="card">
      <div className="flex items-start gap-3">
        <Checkbox
          className="mt-0.5"
          aria-label={`Select ${session.slug}`}
          checked={selected}
          onCheckedChange={(checked) => onSelect(checked)}
        />
        <div className="flex min-w-0 flex-1 flex-col">
          <span className="text-base leading-5 font-medium [overflow-wrap:anywhere]">
            {session.slug}
          </span>
          <span className="truncate text-sm text-muted-foreground">
            <span className="font-mono">{idSuffix(session)}</span>
            {browser !== null ? ` · ${browser}` : ''}
          </span>
          <HarnessName harness={session.harness} className="mt-1 self-start text-sm" />
        </div>
        <div className="-mt-1 -mr-2 shrink-0">{actions}</div>
      </div>
      {url !== null ? (
        <p className="min-w-0 truncate pl-7 font-mono text-sm">
          <span className="text-foreground/85">{url.host}</span>
          <span className="text-muted-foreground">{url.rest}</span>
        </p>
      ) : null}
      <div className="flex items-start justify-between gap-3 pl-7">
        <StateCell session={session} now={now} />
        <ActivityCell session={session} />
      </div>
    </article>
  );
}
