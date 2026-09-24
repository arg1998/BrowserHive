/** @module features/sessions/list/sessions-columns — `/sessions` columns: Session (slug + the id's unique suffix, non-default browser, owner when owners differ) · State (dot + text, lease while live or closed time) · Last URL (grow, never squeezed under 14rem) · Activity (calls, errors only when > 0) · Agent (launch harness over workspace/model) · Created (relative) · row actions. Columns follow the table's own width (container queries, so the sidebar state counts): Created from 64rem, Activity from 56rem, Agent from 48rem and State from 38rem (below those they fold into the Session cell) */
import type { SessionSummary } from '@browserhive/contracts/http';
import type { ReactNode } from 'react';
import { CopyButton } from '@/components/shared/CopyButton.tsx';
import { LeaseBar } from '@/components/shared/lease-bar.tsx';
import { RelativeTime } from '@/components/shared/RelativeTime.tsx';
import { StatusBadge } from '@/components/shared/StatusBadge.tsx';
import { TONE_CLASSES } from '@/components/shared/tones.ts';
import { UrlCell } from '@/components/shared/url-cell.tsx';
import type { DataTableColumn } from '@/components/shared/use-data-table.ts';
import { Hint } from '@/components/ui/tooltip.tsx';
import { formatNumber } from '@/lib/format/bytes.ts';
import { truncateId } from '@/lib/format/ids.ts';
import { harnessLabel, isUnknownHarness } from '@/lib/harness.ts';
import { sessionDisplayState, statusEntry } from '@/lib/status-registry.ts';
import { cn } from '@/lib/utils.ts';
import { HarnessName } from '../../harness/HarnessName.tsx';
import { browserLabel } from '../session-format.ts';

/** The part of a session id that tells same-slug sessions apart (`shop-9f2k1x` → `9f2k1x`). */
export function idSuffix(session: Pick<SessionSummary, 'session_id' | 'slug'>): string {
  const prefix = `${session.slug}-`;
  return session.session_id.startsWith(prefix) && session.session_id.length > prefix.length
    ? session.session_id.slice(prefix.length)
    : truncateId(session.session_id);
}

/**
 * Title cell: the slug (the row link's text) over the id's unique suffix (the slug is already its
 * prefix; the full id is in the tooltip and copies on hover), attributes that differ from the
 * default and, while the Activity column is folded away, the call and error counts.
 */
export function SessionTitleCell({
  session,
  showOwner,
}: {
  readonly session: SessionSummary;
  readonly showOwner: boolean;
}) {
  const browser = browserLabel(session);
  return (
    <span className="flex min-w-0 flex-col">
      <span className="flex min-w-0 items-center gap-2">
        <StateDot session={session} />
        <span className="truncate text-base leading-5 font-medium text-foreground decoration-muted-foreground/60 underline-offset-4 group-hover/row:underline">
          {session.slug}
        </span>
        <HarnessInline session={session} />
      </span>
      <span className="flex min-w-0 items-center gap-1.5 text-sm leading-5 text-muted-foreground">
        <Hint label={<span className="font-mono">{session.session_id}</span>}>
          <span className="shrink-0 font-mono">{idSuffix(session)}</span>
        </Hint>
        <ActivityInline session={session} />
        {browser !== null ? <span className="truncate">· {browser}</span> : null}
        {showOwner ? <span className="truncate">· {session.owner}</span> : null}
        <CopyButton
          value={session.session_id}
          label="Copy session id"
          className="-my-1 pointer-coarse:hidden"
        />
      </span>
    </span>
  );
}

/** The state as a bare dot beside the slug while the State column is folded away (very narrow tables). */
function StateDot({ session }: { readonly session: SessionSummary }) {
  const entry = statusEntry('session', sessionDisplayState(session));
  return (
    <span className="flex shrink-0 @min-[38rem]:hidden">
      <span
        aria-hidden="true"
        className={cn('size-2 rounded-full', TONE_CLASSES[entry.tone].dot)}
      />
      <span className="sr-only">{entry.label}</span>
    </span>
  );
}

/** Activity folded into the Session line while the table is too narrow for its own column. */
function ActivityInline({ session }: { readonly session: SessionSummary }) {
  const { tool_calls: calls, errors } = session.counts;
  return (
    <span className="min-w-0 truncate tabular-nums @min-[56rem]:hidden">
      · {formatNumber(calls)} {calls === 1 ? 'call' : 'calls'}
      {errors > 0 ? (
        <span className="text-danger-text">
          {' '}
          · {formatNumber(errors)} {errors === 1 ? 'error' : 'errors'}
        </span>
      ) : null}
    </span>
  );
}

/** The harness beside the slug while the Agent column is hidden (it gives way to the slug); omitted when unknown. */
function HarnessInline({ session }: { readonly session: SessionSummary }) {
  if (isUnknownHarness(session.harness)) return null;
  return (
    <span className="max-w-[55%] min-w-0 shrink truncate text-sm leading-5 text-muted-foreground @min-[48rem]:hidden">
      {harnessLabel(session.harness)}
    </span>
  );
}

/** Agent: the launch harness (a muted "Unknown" chip when nothing identified it) over the workspace, else the model, when reported. */
export function AgentCell({ session }: { readonly session: SessionSummary }) {
  const client = session.client;
  const detail = client?.workspace ?? client?.agent_name ?? client?.model ?? null;
  return (
    <span className="flex min-w-0 flex-col items-start">
      <HarnessName harness={session.harness} className="max-w-full text-base leading-5" />
      {detail !== null ? (
        <span className="max-w-full truncate text-sm leading-5 text-muted-foreground">
          {detail}
        </span>
      ) : null}
    </span>
  );
}

/** State: dot + text over the lease meter (live) or when it closed; one column instead of a mostly empty Lease column. */
export function StateCell({
  session,
  now,
}: {
  readonly session: SessionSummary;
  readonly now: number;
}) {
  const state = sessionDisplayState(session);
  return (
    <span className="flex min-w-0 flex-col">
      <StatusBadge domain="session" value={state} className="leading-5" />
      {session.live && session.lease_paused_at !== null ? (
        <span className="pl-4 text-sm leading-5 text-muted-foreground">lease paused</span>
      ) : session.live ? (
        <LeaseBar
          remainingMs={session.lease_expires_at - now}
          label="Lease"
          className="h-5 w-32 min-w-0 pl-4 [&_span]:text-sm"
        />
      ) : session.closed_at !== null ? (
        <span className="pl-4 text-sm leading-5 text-muted-foreground">
          <RelativeTime at={session.closed_at} />
        </span>
      ) : null}
    </span>
  );
}

/** `12 calls` and `· 2 errors` / `· 1 blocked` only when non-zero. */
export function ActivityCell({ session }: { readonly session: SessionSummary }) {
  const { tool_calls: calls, errors, blocked } = session.counts;
  return (
    <span className="flex min-w-0 flex-col text-sm leading-5 whitespace-nowrap tabular-nums">
      <span className="text-foreground">
        {formatNumber(calls)} {calls === 1 ? 'call' : 'calls'}
      </span>
      {errors > 0 || blocked > 0 ? (
        <span className="text-danger-text">
          {[
            errors > 0 ? `${formatNumber(errors)} ${errors === 1 ? 'error' : 'errors'}` : null,
            blocked > 0 ? `${formatNumber(blocked)} blocked` : null,
          ]
            .filter((v) => v !== null)
            .join(' · ')}
        </span>
      ) : null}
    </span>
  );
}

/** Build the column set; `now` drives the lease meter, `actions` renders the trailing actions. */
export function sessionColumns(
  now: number,
  actions: (session: SessionSummary) => ReactNode,
  options: { readonly showOwner: boolean } = { showOwner: false },
): readonly DataTableColumn<SessionSummary>[] {
  return [
    {
      id: 'slug',
      header: 'Session',
      sortable: true,
      sortAliases: { channel: 'channel', owner: 'owner', persistence: 'persistence' },
      priority: 1,
      className:
        'w-[13rem] min-w-[13rem] max-w-[18rem] py-1.5 @min-[44rem]:min-w-[14.5rem] @min-[56rem]:min-w-0 @min-[64rem]:w-[15rem]',
      cell: (s) => <SessionTitleCell session={s} showOwner={options.showOwner} />,
    },
    {
      id: 'state',
      header: 'State',
      priority: 1,
      nowrap: true,
      className: 'hidden w-[10.5rem] py-1.5 @min-[38rem]:table-cell',
      cell: (s) => <StateCell session={s} now={now} />,
    },
    {
      id: 'url',
      header: 'Last URL',
      priority: 1,
      grow: true,
      className: 'min-w-[8rem] py-1.5 @min-[38rem]:min-w-[11rem] @min-[56rem]:min-w-[14rem]',
      cell: (s) => <UrlCell url={s.current_url} head={32} tail={16} />,
    },
    {
      id: 'activity',
      header: 'Activity',
      sortable: true,
      sortAliases: { errors: 'errors', blocked: 'blocked' },
      priority: 1,
      className: 'hidden w-28 py-1.5 @min-[56rem]:table-cell',
      cell: (s) => <ActivityCell session={s} />,
    },
    {
      id: 'harness',
      header: 'Agent',
      sortable: true,
      priority: 1,
      className: 'hidden w-36 max-w-[11rem] py-1.5 @min-[48rem]:table-cell',
      cell: (s) => <AgentCell session={s} />,
    },
    {
      id: 'created',
      header: 'Created',
      sortable: true,
      priority: 1,
      nowrap: true,
      className: 'hidden w-24 py-1.5 text-muted-foreground @min-[64rem]:table-cell',
      cell: (s) => <RelativeTime at={s.created_at} className="text-sm" />,
    },
    {
      id: 'actions',
      header: 'Actions',
      priority: 1,
      align: 'end',
      cell: actions,
      revealOnHover: true,
      hideHeader: true,
      className: 'w-[5.5rem] py-1.5',
    },
  ];
}
