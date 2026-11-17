/** @module features/site-packs/DiffView — a field-level pack diff (spec 13 §10.6, §11.4): new domains first, then the changed fields with their old and new values as text (JSON, never markup; the first four, then Show all; a new pack starts folded), unclassified until T3b's classifier; `DiffLoader` fetches `GET /site-packs/{id}/diff` and shows loading, error and empty states */
import type { SitePackDiffResponse } from '@browserhive/contracts/http';
import { useState } from 'react';
import { Chip } from '@/components/shared/Chip.tsx';
import { ErrorState } from '@/components/shared/ErrorState.tsx';
import { Button } from '@/components/ui/button.tsx';
import { Skeleton } from '@/components/ui/skeleton.tsx';
import { toAppError } from '@/lib/api/errors.ts';
import { ICONS } from '@/lib/icons.ts';
import { useSitePackDiff } from './api.ts';
import { valueText } from './model.ts';

/** One value cell. */
function Value({ label, value, tone }: { label: string; value: unknown; tone: 'old' | 'new' }) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <span className="text-xs font-medium text-muted-foreground">{label}</span>
      <pre
        className={
          tone === 'old'
            ? 'min-w-0 rounded-md bg-danger-bg/60 px-2 py-1 font-mono text-xs whitespace-pre-wrap text-foreground [overflow-wrap:anywhere]'
            : 'min-w-0 rounded-md bg-success-bg/60 px-2 py-1 font-mono text-xs whitespace-pre-wrap text-foreground [overflow-wrap:anywhere]'
        }
      >
        {valueText(value)}
      </pre>
    </div>
  );
}

/** Changes shown before "Show all". */
export const DIFF_PREVIEW = 4;

/** The changes of a diff. A new pack (nothing approved yet) starts folded: every field is new. */
export function DiffView({ diff }: { readonly diff: SitePackDiffResponse }) {
  const [open, setOpen] = useState(false);
  const fresh = diff.from === null;
  const limit = fresh ? 0 : DIFF_PREVIEW;
  const shown = open ? diff.changes : diff.changes.slice(0, limit);
  const hidden = diff.changes.length - shown.length;
  return (
    <div className="flex min-w-0 flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
        <span>
          {fresh
            ? `A new pack: all ${diff.changes.length} fields are new`
            : `${diff.changes.length} ${diff.changes.length === 1 ? 'field changes' : 'fields change'}`}
        </span>
        {fresh ? null : diff.classification === 'unclassified' ? (
          <Chip tone="neutral">Unclassified</Chip>
        ) : (
          <Chip tone="info">{diff.classification.replaceAll('_', ' ')}</Chip>
        )}
      </div>
      {fresh && diff.new_domains.length > 0 ? (
        <p className="text-sm text-muted-foreground">
          Covers <span className="font-mono text-foreground">{diff.new_domains.join(', ')}</span>
        </p>
      ) : null}
      {!fresh && diff.new_domains.length > 0 ? (
        <p className="rounded-lg bg-warn-bg px-3 py-2 text-sm text-warn-text">
          <span className="font-medium">New domains:</span>{' '}
          <span className="font-mono">{diff.new_domains.join(', ')}</span>. The pack’s guards and
          checks will cover them too.
        </p>
      ) : null}
      {diff.changes.length === 0 ? (
        <p className="text-sm text-muted-foreground">The content is the same.</p>
      ) : shown.length === 0 ? null : (
        <ol className="flex min-w-0 flex-col divide-y rounded-lg border">
          {shown.map((change) => (
            <li key={change.path} className="flex min-w-0 flex-col gap-2 px-3 py-2.5">
              <span className="font-mono text-sm font-medium [overflow-wrap:anywhere]">
                {change.path}
              </span>
              <div className="grid min-w-0 gap-2 sm:grid-cols-2">
                <Value label="Before" value={change.from} tone="old" />
                <Value label="After" value={change.to} tone="new" />
              </div>
            </li>
          ))}
        </ol>
      )}
      {hidden > 0 || (open && diff.changes.length > limit) ? (
        <div>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            aria-expanded={open}
            onClick={() => setOpen((v) => !v)}
          >
            <ICONS.chevronDown
              aria-hidden="true"
              className={open ? 'rotate-180 transition-transform' : 'transition-transform'}
            />
            {open
              ? 'Show fewer'
              : fresh
                ? `Show its content (${diff.changes.length} fields)`
                : `Show all ${diff.changes.length} changes`}
          </Button>
        </div>
      ) : null}
    </div>
  );
}

/** Fetch and show the diff to a pending version or the local file. */
export function DiffLoader({
  packId,
  to,
}: {
  readonly packId: string;
  readonly to: number | 'local';
}) {
  const diff = useSitePackDiff(packId, to);
  if (diff.isPending)
    return (
      <div role="status" aria-busy="true" aria-label="Loading the changes">
        <Skeleton className="h-20 rounded-lg" />
      </div>
    );
  if (diff.isError)
    return (
      <ErrorState
        tier="region"
        error={toAppError(diff.error)}
        onRetry={() => void diff.refetch()}
      />
    );
  return <DiffView diff={diff.data} />;
}
