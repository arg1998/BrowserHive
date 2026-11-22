/** @module features/site-packs/DiffView — a field-level pack diff (spec 13 §10.6, §11.4): new domains first, then the classified changes (what the candidate's class means, counts per class, fields that relax rules or can stop the site first and highlighted, each with its class) with their old and new values as text (JSON, never markup; the first four, then Show all; a new pack starts folded); `DiffLoader` fetches `GET /site-packs/{id}/diff` and shows loading, error and empty states */
import type { SitePackDiffResponse } from '@browserhive/contracts/http';
import { useState } from 'react';
import { ErrorState } from '@/components/shared/ErrorState.tsx';
import { Button } from '@/components/ui/button.tsx';
import { Skeleton } from '@/components/ui/skeleton.tsx';
import { toAppError } from '@/lib/api/errors.ts';
import { printable } from '@/lib/format/printable.ts';
import { ICONS } from '@/lib/icons.ts';
import { cn } from '@/lib/utils.ts';
import { useSitePackDiff } from './api.ts';
import { ClassificationChip } from './ClassificationChip.tsx';
import { bySeverity, CLASSIFICATION_INFO, classCounts, countText } from './classification.ts';
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

/** Highlight of a field that needs a careful look (loosening or restrictive); `''` otherwise. */
const ROW_TONE: Readonly<Record<string, string>> = {
  loosening: 'border-l-danger-solid bg-danger-bg/35',
  restrictive: 'border-l-warn-solid bg-warn-bg/35',
};

/**
 * The headline of a classified diff: how many fields change per class and what the candidate's
 * class means (the card around it shows the candidate's chip).
 */
function DiffSummary({ diff }: { readonly diff: SitePackDiffResponse }) {
  const info = CLASSIFICATION_INFO[diff.classification];
  const counts = classCounts(diff.changes);
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <span className="text-sm font-medium text-foreground">
          {diff.changes.length} {diff.changes.length === 1 ? 'field changes' : 'fields change'}
          {counts.length > 1
            ? `: ${counts.map((c) => countText(c.cls, c.count)).join(' · ')}`
            : null}
        </span>
      </div>
      {diff.classification !== 'unclassified' ? (
        <p className="max-w-3xl text-sm text-pretty text-muted-foreground">
          <span className="sr-only">{info.label}: </span>
          {info.summary}
        </p>
      ) : null}
    </div>
  );
}

/** One changed field: its path, its class, before and after as text. */
function ChangeItem({ change }: { readonly change: SitePackDiffResponse['changes'][number] }) {
  const tone = change.class === null ? undefined : ROW_TONE[change.class];
  return (
    <li
      data-class={change.class ?? 'none'}
      className={cn(
        'flex min-w-0 flex-col gap-2 border-l-[3px] border-l-transparent px-3 py-2.5',
        tone,
      )}
    >
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-x-3 gap-y-1">
        <span className="min-w-0 font-mono text-sm font-medium [overflow-wrap:anywhere]">
          {printable(change.path)}
        </span>
        {change.class !== null ? <ClassificationChip classification={change.class} /> : null}
      </div>
      <div className="grid min-w-0 gap-2 sm:grid-cols-2">
        <Value label="Before" value={change.from} tone="old" />
        <Value label="After" value={change.to} tone="new" />
      </div>
    </li>
  );
}

/**
 * The changes of a diff, classified (spec 13 §9.7): fields that relax rules or can stop the site
 * come first and are highlighted. A new pack (nothing approved yet) starts folded: every field is
 * new.
 */
export function DiffView({ diff }: { readonly diff: SitePackDiffResponse }) {
  const fresh = diff.from === null;
  // A first version compared with nothing lists every field, those that need care first and
  // highlighted: it needs an explicit review (review #100 M2).
  const [open, setOpen] = useState(fresh);
  const limit = DIFF_PREVIEW;
  const ordered = bySeverity(diff.changes);
  const shown = open ? ordered : ordered.slice(0, limit);
  const hidden = ordered.length - shown.length;
  return (
    <div className="flex min-w-0 flex-col gap-3">
      {fresh ? (
        <p className="text-sm text-muted-foreground">
          Nothing to compare with: all {diff.changes.length} fields are new. Read each before you
          apply it.
        </p>
      ) : (
        <DiffSummary diff={diff} />
      )}
      {fresh && diff.new_domains.length > 0 ? (
        <p className="text-sm text-muted-foreground">
          Covers{' '}
          <span className="font-mono text-foreground">
            {printable(diff.new_domains.join(', '))}
          </span>
        </p>
      ) : null}
      {!fresh && diff.new_domains.length > 0 ? (
        <p className="rounded-lg border-l-[3px] border-l-warn-solid bg-warn-bg px-3 py-2 text-sm text-warn-text">
          <span className="font-medium">New domains:</span>{' '}
          <span className="font-mono">{printable(diff.new_domains.join(', '))}</span>. The pack’s
          guards and checks will cover them too.
        </p>
      ) : null}
      {diff.changes.length === 0 ? (
        <p className="text-sm text-muted-foreground">The content is the same.</p>
      ) : shown.length === 0 ? null : (
        <ol
          aria-label="Changed fields"
          className="flex min-w-0 flex-col divide-y overflow-hidden rounded-lg border"
        >
          {shown.map((change) => (
            <ChangeItem key={change.path} change={change} />
          ))}
        </ol>
      )}
      {hidden > 0 || (open && ordered.length > limit) ? (
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
              : `Show all ${diff.changes.length} ${fresh ? 'fields' : 'changes'}`}
          </Button>
        </div>
      ) : null}
    </div>
  );
}

/** A diff query's states: loading, error, the diff. */
export function DiffPanel({ query }: { readonly query: ReturnType<typeof useSitePackDiff> }) {
  if (query.isPending)
    return (
      <div role="status" aria-busy="true" aria-label="Loading the changes">
        <Skeleton className="h-20 rounded-lg" />
      </div>
    );
  if (query.isError)
    return (
      <ErrorState
        tier="region"
        error={toAppError(query.error)}
        onRetry={() => void query.refetch()}
      />
    );
  return <DiffView diff={query.data} />;
}

/** Fetch and show the diff to a pending version or the local file. */
export function DiffLoader({
  packId,
  to,
}: {
  readonly packId: string;
  readonly to: number | 'local';
}) {
  return <DiffPanel query={useSitePackDiff(packId, to)} />;
}
