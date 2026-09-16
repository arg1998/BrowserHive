/** @module components/shared/session-ref — the only session-id renderer: slug is primary and truncates last, the mono id is secondary, copy appears on hover */
import { Link } from '@tanstack/react-router';
import { Hint } from '@/components/ui/tooltip.tsx';
import { sessionSlug, truncateId } from '@/lib/format/ids.ts';
import { cn } from '@/lib/utils.ts';
import { CopyButton } from './CopyButton.tsx';

/** Props. */
export interface SessionRefProps {
  readonly id: string;
  /** Human slug; derived from the id when omitted. */
  readonly slug?: string;
  /** `link` (default) navigates to the session; `text` for rows that are already links and headers. */
  readonly mode?: 'link' | 'text';
  /** Show the id next to (or under, with `stacked`) the slug (default `true`). */
  readonly showId?: boolean;
  /** Truncate the id to 8/6 characters (default `true`); the full id is in a tooltip. */
  readonly truncate?: boolean;
  /** Put the id on its own line under the slug (table title cells). */
  readonly stacked?: boolean;
  readonly className?: string;
}

/** Session reference: slug · mono id · copy (on hover). */
export function SessionRef({
  id,
  slug,
  mode = 'link',
  showId = true,
  truncate = true,
  stacked = false,
  className,
}: SessionRefProps) {
  const label = slug ?? sessionSlug(id);
  const shownId = truncate ? truncateId(id) : id;
  const title =
    mode === 'link' ? (
      <Link
        to="/sessions/$id"
        params={{ id }}
        className="max-w-full shrink-0 truncate font-medium text-foreground decoration-muted-foreground/60 underline-offset-4 hover:underline group-hover/row:underline"
      >
        {label}
      </Link>
    ) : (
      <span className="max-w-full shrink-0 truncate font-medium text-foreground group-hover/row:underline group-hover/row:decoration-muted-foreground/60 group-hover/row:underline-offset-4">
        {label}
      </span>
    );
  const idNode = showId ? (
    <span className="inline-flex min-w-0 items-center gap-0.5">
      <Hint label={shownId !== id ? <span className="font-mono">{id}</span> : null}>
        <span className="min-w-0 truncate font-mono text-sm text-muted-foreground">{shownId}</span>
      </Hint>
      <CopyButton value={id} label={`Copy session id ${id}`} className="pointer-coarse:hidden" />
    </span>
  ) : (
    <CopyButton value={id} label={`Copy session id ${id}`} />
  );
  return (
    <span
      data-reveal-scope=""
      className={cn(
        'inline-flex max-w-full min-w-0',
        stacked ? 'flex-col items-start gap-0' : 'flex-wrap items-center gap-x-2 gap-y-0',
        className,
      )}
    >
      {title}
      {idNode}
    </span>
  );
}
