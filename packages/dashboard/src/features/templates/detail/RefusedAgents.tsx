/** @module features/templates/detail/RefusedAgents — the Access tab's "Refused agents" (deferred D60): every client the saved access rule turned away, one row per principal, harness and kind (a listing or a launch) with how often and when it was last refused, the rule that refused it and where to allow it; the agent itself saw no template. Re-read on focus and every 30 s. */
import { REFUSAL_OTHER_HARNESSES, type TemplateRefusalRow } from '@browserhive/contracts/http';
import { useId } from 'react';
import { Chip } from '@/components/shared/Chip.tsx';
import { DataTable } from '@/components/shared/DataTable.tsx';
import { EmptyState } from '@/components/shared/EmptyState.tsx';
import { ErrorState } from '@/components/shared/ErrorState.tsx';
import { RelativeTime } from '@/components/shared/RelativeTime.tsx';
import { SkeletonTable } from '@/components/shared/Skeletons.tsx';
import type { DataTableColumn } from '@/components/shared/use-data-table.ts';
import { Button } from '@/components/ui/button.tsx';
import { HarnessName } from '@/features/harness/HarnessName.tsx';
import { toAppError } from '@/lib/api/errors.ts';
import { formatNumber } from '@/lib/format/bytes.ts';
import { useTemplateRefusals } from '../api.ts';

/** The id of the Access tab's rule fields (the "Edit access rules" target). */
export const ACCESS_RULES_ID = 'template-access-rules';

const KIND_LABEL = { list: 'Listing', launch: 'Launch' } as const;

/** Which field of the Access tab would let this client in. */
const FIX = {
  principal_not_allowed: 'Not in Who may use',
  harness_not_allowed: 'Harness not allowed',
} as const;

function times(n: number): string {
  return `${formatNumber(n)} ${n === 1 ? 'time' : 'times'}`;
}

function HarnessCell({ row }: { readonly row: TemplateRefusalRow }) {
  // A client's harness names past its first few are counted together (review #93 L2).
  if (row.harness === REFUSAL_OTHER_HARNESSES) {
    return <span className="text-sm text-muted-foreground">Other harness names</span>;
  }
  return (
    <span className="flex min-w-0 flex-col gap-0.5">
      <HarnessName harness={row.harness} className="self-start" />
      {row.harness_declared !== null ? (
        <span className="truncate font-mono text-xs text-muted-foreground">
          {row.harness_declared}
        </span>
      ) : null}
    </span>
  );
}

const COLUMNS: readonly DataTableColumn<TemplateRefusalRow>[] = [
  {
    id: 'principal',
    header: 'Client',
    mono: true,
    truncate: true,
    className: 'max-w-64',
    cell: (r) => r.principal,
  },
  { id: 'harness', header: 'Harness', className: 'max-w-56', cell: (r) => <HarnessCell row={r} /> },
  {
    id: 'kind',
    header: 'What',
    nowrap: true,
    cell: (r) => <Chip tone="neutral">{KIND_LABEL[r.kind]}</Chip>,
  },
  {
    id: 'reason',
    header: 'Refused by',
    nowrap: true,
    priority: 2,
    cell: (r) => <span className="text-sm text-muted-foreground">{FIX[r.reason]}</span>,
  },
  {
    id: 'count',
    header: 'Times',
    align: 'end',
    nowrap: true,
    cell: (r) => <span className="tabular-nums">{formatNumber(r.count)}</span>,
  },
  {
    id: 'last',
    header: 'Last seen',
    nowrap: true,
    grow: true,
    cell: (r) => <RelativeTime at={r.last_at} />,
  },
];

function RefusalCard({ row }: { readonly row: TemplateRefusalRow }) {
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="min-w-0 truncate font-mono text-sm">{row.principal}</span>
        <Chip tone="neutral">{KIND_LABEL[row.kind]}</Chip>
      </div>
      <HarnessCell row={row} />
      <span className="text-sm text-muted-foreground">
        {FIX[row.reason]} · {times(row.count)} · <RelativeTime at={row.last_at} />
      </span>
    </div>
  );
}

function scrollToRules(): void {
  const target = document.getElementById(ACCESS_RULES_ID);
  target?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  target
    ?.querySelector<HTMLElement>('input, button, [tabindex="0"]')
    ?.focus({ preventScroll: true });
}

/** Refused agents of one template. */
export function RefusedAgents({ templateId }: { readonly templateId: string }) {
  const titleId = useId();
  const query = useTemplateRefusals(templateId);
  const rows = query.data?.data ?? [];
  const full = query.data !== undefined && rows.length >= query.data.max_rows;
  return (
    <section aria-labelledby={titleId} className="flex min-w-0 flex-col gap-3">
      <div className="flex flex-wrap items-end justify-between gap-x-4 gap-y-2">
        <div className="flex min-w-0 flex-col gap-0.5">
          <h2 id={titleId} className="text-base font-semibold">
            Refused agents
          </h2>
          <p className="max-w-2xl text-sm text-pretty text-muted-foreground">
            Agents your access rules refused. They saw no template.
            {rows.length > 0
              ? ' To let one in, add its client under Who may use or its harness under Harnesses, then save.'
              : ''}
            {full ? ` Only the ${formatNumber(rows.length)} seen most recently are kept.` : ''}
          </p>
        </div>
        {rows.length > 0 ? (
          <Button type="button" size="sm" variant="outline" onClick={scrollToRules}>
            Edit access rules
          </Button>
        ) : null}
      </div>
      {query.isError ? (
        <ErrorState
          tier="region"
          variant="panel"
          error={toAppError(query.error)}
          onRetry={() => void query.refetch()}
        />
      ) : query.data === undefined ? (
        <SkeletonTable rowCount={3} />
      ) : (
        <div className="@container min-w-0">
          <DataTable<TemplateRefusalRow>
            label="Refused clients"
            columns={COLUMNS}
            rows={rows}
            state={{ page: 1, pageSize: 100 }}
            getRowId={(r) => `${r.principal} ${r.harness} ${r.harness_declared ?? ''} ${r.kind}`}
            onStateChange={() => undefined}
            stickyHeader={false}
            renderCard={(r) => <RefusalCard row={r} />}
            rowLabel={(r) => `${r.principal} ${KIND_LABEL[r.kind]}`}
            emptyState={
              <EmptyState
                kind="zero-data"
                size="sm"
                icon="secured"
                title="No agent refused"
                description="When your access rules turn an agent away from this template, it is listed here with its harness and how often it tried."
              />
            }
          />
        </div>
      )}
    </section>
  );
}
